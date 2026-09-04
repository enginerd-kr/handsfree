import type { StopReason } from '@agentclientprotocol/sdk';
import { agentRole, contextBudgetTokens, plannerLabel, type Config } from '../config/schema.js';
import {
  estimateTokens,
  fitBudget,
  trimHistory,
  type ChatClient,
  type ChatMessage,
} from '../brain/client.js';
import type { OrchestrationChoice } from '../brain/planner.js';
import { narrate, renderLedger } from '../brain/narrate.js';
import {
  composeUserMessage,
  nextStep,
  planSystemPrompt,
  renderState,
  type AgentCard,
  type AnswerStream,
} from '../brain/plan.js';
import { debug } from '../debug.js';
import { SessionUnresponsiveError, type TurnUsage } from '../host/session.js';
import type { ModelChoice } from '../host/models.js';
import { type AgentPool, AgentStartError } from '../host/pool.js';
import type { Transcript } from '../workspace/transcript.js';
import type { Workspace } from '../workspace/workspace.js';
import { expandBody } from '../slash/expand.js';
import {
  findCommand,
  looksLikeCommand,
  parseSlashCommand,
  type Command,
  type CommandBase,
  type CommandHost,
  type LocalCommand,
} from '../slash/command.js';
import { parseMention, parseOrchestration } from '../mention/mention.js';
import {
  agentRecords,
  floorOf,
  LEDGER_TASKS,
  renderAgentRecord,
  renderHandoff,
  renderRunState,
  tasksSince,
  type LedgerOptions,
} from './ledger.js';
import { summarise, renderOutcome, type TaskOutcome } from './outcome.js';
import { buildBrief, type TaskKind } from './prompts.js';
import { DEFAULT_REPORT_LIMITS } from './report.js';
import { metered } from './usage.js';

/**
 * How much of the planner's budget the system prompt, the run state and the
 * user's line may take between them before the run state is shortened. The
 * rest is for the history, and for the steps a turn adds as it goes.
 */
const STATE_SHARE = 0.6;

export interface ConversationDeps {
  config: Config;
  pool: AgentPool;
  transcript: Transcript;
  workspace: Workspace;
  llm: ChatClient | undefined;
  /**
   * Moves the orchestration model, for `@orchestrator:agent:model`, answering
   * with the line that says where it went. Absent where there is nothing to
   * move — a run started without a planner at all — and the address is then
   * answered by saying so rather than by silently doing nothing.
   */
  useOrchestration?: (choice: OrchestrationChoice) => Promise<string>;
  commands: readonly Command[];
  /** A context for a command to act in, named after the command doing the asking. */
  commandHost: (agentId: string) => CommandHost;
}

/**
 * One user turn: plan, delegate, report. Everything it learns goes into the
 * transcript as it happens, and a turn that runs its course ends with the user
 * being told what became of the work — including when the planning model fails
 * or the agent dies. A cancelled turn is the exception: Esc means stop, and
 * answering it would be one more thing the user has to wait through.
 */
/**
 * One reply of handsfree's own, shown as it is written. Deltas open the block,
 * `end` settles it on the final text, and `retract` takes it back — for when
 * what streamed turned out to be a delegation or unusable JSON, not an answer.
 * A reply that never streamed ends as the plain assistant record it always was.
 */
class AssistantStream implements AnswerStream {
  private open = false;

  constructor(
    private readonly transcript: Transcript,
    private readonly id: number,
  ) {}

  delta(text: string): void {
    if (text === '') return;
    this.open = true;
    this.transcript.append({ type: 'assistant_delta', stream: this.id, text });
  }

  retract(): void {
    if (!this.open) return;
    this.open = false;
    this.transcript.append({ type: 'assistant', stream: this.id, text: '' });
  }

  end(text: string, ledger = false): void {
    const flag = ledger ? { ledger: true } : {};
    if (this.open) {
      this.open = false;
      this.transcript.append({ type: 'assistant', stream: this.id, text, ...flag });
    } else {
      this.transcript.append({ type: 'assistant', text, ...flag });
    }
  }
}

/**
 * What handsfree remembers about having briefed an agent: which session heard
 * the ground rules, how many tasks it has had since, how the last one ended,
 * and where in the record its last task stopped — the line "since your last
 * task" is drawn at.
 */
interface Briefing {
  sessionId: string;
  tasksSinceRules: number;
  lastStop: StopReason | 'unresponsive';
  /** The seq of the agent's last `stop`; handoffs are what came after it. */
  since: number;
}

export class Conversation {
  private messages: ChatMessage[] = [];
  private taskCounter = 0;
  private streamCounter = 0;
  private turn: AbortController | undefined;
  private inflight: Promise<void> | undefined;
  private readonly briefed = new Map<string, Briefing>();
  /**
   * Which conversation this is. `/clear` does not queue behind a turn — it is
   * over the moment it runs — so a turn can outlive the history it was
   * started against. Everything that writes back into that history checks the
   * epoch it began under first, and an orphaned turn finishes, reports, and
   * leaves no trace in the conversation that replaced it.
   */
  private epoch = 0;

  constructor(private readonly deps: ConversationDeps) {
    // A run read back off its file has tasks and replies in it already; the
    // next of each has to be numbered after them, or the view keys two rows
    // on one id and the ledger reads two tasks as one.
    for (const record of deps.transcript.all()) {
      if (record.type === 'delegation') this.taskCounter = Math.max(this.taskCounter, record.taskId);
      if ((record.type === 'assistant' || record.type === 'assistant_delta') && record.stream !== undefined) {
        this.streamCounter = Math.max(this.streamCounter, record.stream);
      }
    }
  }

  get isBusy(): boolean {
    return this.turn !== undefined;
  }

  cancel(): void {
    this.turn?.abort();
  }

  reset(): void {
    this.epoch++;
    this.messages = [];
    // The ground rules go with the history. An agent that keeps its session
    // across a clear would otherwise never hear them again, and the first
    // brief after starting over would be the one that explains nothing.
    // The counters deliberately do not reset: the view keys rows by them, and
    // a second task 1 would land on the first one's row.
    this.briefed.clear();
  }

  /**
   * Ends the conversation for good: cancels the turn like cancel() does, then
   * waits for it to settle — so the caller knows nothing will be appended
   * after it, and no request is left holding the process open.
   */
  async close(): Promise<void> {
    this.turn?.abort();
    await this.inflight?.catch(() => {});
  }

  async send(text: string): Promise<void> {
    const work = this.run(text);
    this.inflight = work;
    try {
      await work;
    } finally {
      if (this.inflight === work) this.inflight = undefined;
    }
  }

  private async run(text: string): Promise<void> {
    const { config, transcript, workspace } = this.deps;

    // A command is answered before the agent roster is even consulted:
    // `/help` and `/config` are wanted most on exactly the machine where
    // nothing is configured yet.
    const invoked = this.invoked(text);
    if (invoked === 'unknown') {
      transcript.append({ type: 'user', text });
      transcript.append({
        type: 'note',
        level: 'error',
        text: `no such command as ${text.trim().split(/\s/)[0]}. /help lists the ones there are.`,
      });
      return;
    }

    transcript.append({ type: 'user', text });

    if (invoked && invoked.command.kind === 'local') {
      this.local(invoked.command, invoked.args);
      return;
    }

    const agents = this.deps.pool.available();
    if (agents.length === 0) {
      transcript.append({ type: 'assistant', text: 'No agents are enabled in the configuration.' });
      return;
    }

    // What the model is actually asked. For a command file that is its
    // expanded body; the record above keeps the line the user typed, because
    // a transcript of expansions is not a transcript of the conversation.
    let prompt = text;

    // `@orchestrator:agent:model` moves the planner itself, and is answered
    // here rather than routed anywhere: no agent is woken and nothing is
    // delegated. Whatever follows the address — where anything does — is then
    // the first thing the new planner is asked, so a move and a task can be
    // the one line.
    if (!invoked) {
      const moved = parseOrchestration(text, agents);
      if (moved) {
        if (!(await this.moveOrchestration(moved)) || moved.rest === '') return;
        prompt = moved.rest;
      }
    }

    const turn = new AbortController();
    this.turn = turn;
    const outcomes: TaskOutcome[] = [];
    const notes: string[] = [];
    let answered = false;
    /**
     * Whether the turn closes on the ledger as it stands, with no narrator.
     * A line that named its agent ran one task the user watched to the end;
     * a summary of that would only say what the ledger already says, and
     * costs a planner round trip after the agent has already finished.
     */
    let ledgerOnly = false;
    let delegations = 0;
    /**
     * The turn as the planner will remember it: the line the user typed and
     * the reply that closed it. Everything between — the steps, the task
     * results — is dropped once the turn is over, since what they said is by
     * then in the run state. `sent` is the line as it went out, with the run
     * state ahead of it; `opening` is the line alone, which is what the
     * history keeps once the turn is over, so what was sent before never
     * changes under the messages that come after it.
     */
    let sent: ChatMessage | undefined;
    let opening: ChatMessage | undefined;
    let closing: string | undefined;
    const epoch = this.epoch;
    let history: ChatMessage[] = this.messages;

    try {
      // Inside the turn, and holding its signal: expansion can run a command,
      // and a turn nobody can escape out of yet is not one this UI promises.
      if (invoked && invoked.command.kind === 'prompt') {
        prompt = await expandBody(
          invoked.command,
          invoked.args,
          this.deps.commandHost(`/${invoked.command.name}`),
          turn.signal,
        );
      }
      this.ensureSystemPrompt(agents);
      // The turn holds the history it was started against, rather than
      // reaching for `this.messages` each time it has something to add. A
      // `/clear` mid-turn puts a new array there, and a turn that followed it
      // would go on planning against a conversation with no system prompt in
      // it — the one thing it must never be asked to do.
      history = this.messages;
      opening = { role: 'user', content: prompt };
      sent = { role: 'user', content: composeUserMessage(this.runState(agents, prompt), prompt) };
      history.push(sent);

      // A line that leads with "@agent" has already chosen its recipient, so
      // the planner is never consulted: what follows the name is the task,
      // sent as written — and a ":model" suffix on the name is the model the
      // work should run on. The step still goes into the history as the JSON
      // the planner would have written, so the turns after this one read the
      // same conversation whichever way the task was routed.
      const mention = invoked ? undefined : parseMention(prompt, agents);
      if (mention) {
        ledgerOnly = true;
        delegations++;
        history.push({
          role: 'assistant',
          content: JSON.stringify({
            action: 'delegate',
            agent: mention.agent,
            kind: 'change',
            task: mention.task,
            ...(mention.model === undefined ? {} : { model: mention.model }),
          }),
        });
        const outcome = await this.delegate(
          mention.agent,
          'change',
          mention.task,
          undefined,
          undefined,
          turn.signal,
          mention.model,
        );
        outcomes.push(outcome);
        history.push({ role: 'user', content: this.relay(outcome) });
        return;
      }

      for (let step = 0; step < config.limits.maxPlanSteps; step++) {
        if (turn.signal.aborted) break;

        const stream = this.newStream();
        const planned = await this.plan(history, agents, turn.signal, stream);
        if (!planned.ok) {
          stream.retract();
          notes.push(`The orchestration model did not produce a usable next step (${planned.error}).`);
          break;
        }
        history.push({ role: 'assistant', content: JSON.stringify(planned.step) });

        if (planned.step.action === 'answer') {
          stream.end(planned.step.message);
          answered = true;
          closing = JSON.stringify(planned.step);
          break;
        }
        // The step is a delegation; anything its JSON streamed was not a reply.
        stream.retract();

        if (delegations >= config.limits.maxDelegationsPerTurn) {
          notes.push(`Stopped at the limit of ${config.limits.maxDelegationsPerTurn} tasks per message.`);
          break;
        }
        delegations++;

        const outcome = await this.delegate(
          planned.step.agent,
          planned.step.kind,
          planned.step.task,
          planned.step.done_when,
          planned.step.context,
          turn.signal,
        );
        outcomes.push(outcome);
        history.push({ role: 'user', content: this.relay(outcome) });

        if (outcome.status === 'cancelled' || outcome.status === 'error') break;
      }
    } catch (err) {
      if (!turn.signal.aborted) notes.push(`The turn stopped: ${(err as Error).message}`);
    } finally {
      // A cancelled turn ends where it stood, silently: the delegation and
      // stop records already say what ran, and the user asked for a stop, not
      // a report about stopping. Skipping the summary is also what lets /exit
      // end the process instead of waiting on one nobody would read.
      //
      // A turn routed by its own @mention closes on the ledger instead: the
      // user chose the agent and watched its one task run, so the record —
      // status, files, refusals, the agent's own summary — is the report,
      // and it is on screen the moment the agent stops rather than a
      // planner call later.
      if (!answered && !turn.signal.aborted) {
        const stream = this.newStream();
        const summary = ledgerOnly
          ? {
              text: renderLedger({ userMessage: prompt, outcomes, notes, workspaceDir: workspace.dir }),
              ledger: true,
            }
          : outcomes.length > 0 || notes.length > 0
            ? await narrate(
                this.deps.llm && metered(this.deps.llm, 'narrate', transcript, plannerLabel(config)),
                { userMessage: prompt, outcomes, notes, workspaceDir: workspace.dir },
                turn.signal,
                (piece) => stream.delta(piece),
              )
            : { text: 'Nothing to do.', ledger: false };
        // Kept in the shape of every other reply of the planner's, so the
        // history it reads back is JSON all the way down: a prose turn among
        // JSON ones is the example a small model imitates next.
        closing = JSON.stringify({ action: 'answer', message: summary.text });
        stream.end(summary.text, summary.ledger);
      }
      if (sent && opening) this.settle(epoch, history, sent, opening, closing);
      this.turn = undefined;
    }
  }

  /**
   * What the planner is handed when a task ends: the head, the report's
   * summary and open items, and — unless the config asks for the whole reply
   * — a reminder that the user has already seen the rest. Written down as it
   * goes out, against what the agent actually said, so `/cost` can say what
   * the report contract saved.
   */
  private relay(outcome: TaskOutcome): string {
    const { config, transcript, workspace } = this.deps;
    const relayMessage = config.orchestration.relayAnswers;
    const lines = [renderOutcome(outcome, workspace.dir, { relayMessage })];
    if (!relayMessage && outcome.message) {
      lines.push(`(The user has already seen ${outcome.agentId}'s full reply on screen; do not repeat it.)`);
    }
    const result = `TASK RESULT\n${lines.join('\n')}`.slice(0, config.limits.maxResultChars);
    transcript.append({
      type: 'usage',
      purpose: 'task',
      taskId: outcome.taskId,
      promptChars: outcome.briefChars ?? 0,
      replyChars: outcome.message.length,
      relayedChars: result.length,
    });
    return result;
  }

  /**
   * Closes the turn in the planner's history: the line the user typed, then
   * the reply — and nothing of the steps and results in between. Those are
   * bulk once the turn is over, and what they established is in the run
   * state, which is rebuilt from the record at the start of every turn. The
   * run state that went out ahead of the line goes too: it was true then and
   * is stale now, and the next turn carries a current one. A turn that
   * stopped before it could reply closes on a line saying so, because two
   * user lines in a row is a shape some chat templates refuse.
   */
  private settle(
    epoch: number,
    history: readonly ChatMessage[],
    sent: ChatMessage,
    opening: ChatMessage,
    closing: string | undefined,
  ): void {
    // The conversation this turn was speaking into is gone: `/clear` replaced
    // it while the turn was still running. The turn still answered the person
    // who asked — that went to the transcript — but folding it into a history
    // that is meant to be empty would put half a turn in a cleared screen.
    if (epoch !== this.epoch) return;
    const at = history.indexOf(sent);
    if (at === -1) return;
    const reply = closing ?? JSON.stringify({ action: 'answer', message: '(stopped before finishing)' });
    // A new array rather than a splice: the one being replaced was handed to
    // the planner on every step of this turn, and a client that kept it —
    // anything queueing, retrying or recording — must keep what it was sent.
    this.messages = trimHistory(
      [...history.slice(0, at), opening, { role: 'assistant', content: reply }],
      this.deps.config.orchestration.maxHistoryMessages,
    );
  }

  /**
   * The planner moved, and said where to. A refusal — an agent nobody
   * configured, one switched off, a model it does not offer — stops the line
   * there: what was asked for was a different planner, and running the work on
   * the old one is not that.
   */
  private async moveOrchestration(choice: OrchestrationChoice): Promise<boolean> {
    const { transcript, useOrchestration } = this.deps;
    if (!useOrchestration) {
      transcript.append({
        type: 'note',
        level: 'error',
        text: 'there is no orchestration model here to move.',
      });
      return false;
    }
    try {
      const moved = await useOrchestration(choice);
      transcript.append({ type: 'note', level: 'info', text: moved });
      return true;
    } catch (err) {
      transcript.append({ type: 'note', level: 'error', text: (err as Error).message });
      return false;
    }
  }

  private async plan(
    history: readonly ChatMessage[],
    agents: string[],
    signal: AbortSignal,
    stream: AnswerStream,
  ) {
    if (!this.deps.llm) {
      return { ok: false as const, error: 'no orchestration model is configured' };
    }
    try {
      const llm = metered(this.deps.llm, 'plan', this.deps.transcript, plannerLabel(this.deps.config));
      // Cut to the budget on the way out, not in place: the history keeps
      // every message a turn adds, and what is dropped is the oldest of it.
      const budget = contextBudgetTokens(this.deps.config.orchestration);
      return await nextStep(llm, fitBudget(history, budget), agents, signal, stream);
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }

  private newStream(): AssistantStream {
    return new AssistantStream(this.deps.transcript, ++this.streamCounter);
  }

  /** How the record is read into outcomes: where the workspace is, how long a summary may be. */
  private ledgerOptions(): LedgerOptions {
    const { config, workspace } = this.deps;
    return {
      workspaceDir: workspace.dir,
      report: { ...DEFAULT_REPORT_LIMITS, summaryChars: config.limits.reportSummaryChars },
    };
  }

  private async delegate(
    agentId: string,
    kind: TaskKind,
    task: string,
    doneWhen: string | undefined,
    context: string | undefined,
    signal: AbortSignal,
    model?: string,
  ): Promise<TaskOutcome> {
    const { config, pool, transcript, workspace } = this.deps;
    const taskId = ++this.taskCounter;
    const startedAt = Date.now();
    // What is remembered about this agent belongs to the conversation this
    // task was started in. A `/clear` while it runs empties that, and writing
    // the briefing back afterwards would quietly restore a session's claim to
    // have heard rules that were cleared along with everything else.
    const epoch = this.epoch;
    const options = this.ledgerOptions();

    const failed = (err: unknown): TaskOutcome => {
      const outcome = summarise(taskId, agentId, task, 'unresponsive', [], Date.now() - startedAt, options);
      // An agent that would not start is already on the record, by the pool.
      if (!(err instanceof AgentStartError)) {
        transcript.append({ type: 'note', level: 'error', text: (err as Error).message });
      }
      const message = (err as Error).message;
      return { ...outcome, message, report: { ...outcome.report, summary: message } };
    };

    // The model is settled before the task is even on the record: a name the
    // agent cannot answer to should fail the routing, not run on whatever the
    // session happened to be on. What it resolves to sticks to the session, so
    // the next task rides the same choice until another mention moves it.
    let session;
    let chosen: ModelChoice | undefined;
    try {
      session = await pool.session(agentId);
      if (model !== undefined) chosen = await session.selectModel(model);
    } catch (err) {
      return failed(err);
    }

    transcript.append({
      type: 'delegation',
      taskId,
      agentId,
      sessionId: session.sessionId,
      task,
      // The id is what went on the wire, so the id is what is written down.
      ...(chosen === undefined ? {} : { model: chosen.value }),
    });

    // The ground rules go out to a session that has not heard them — one just
    // opened, or one that replaced a discarded process — and again to one
    // that may have lost them: after a turn cut off at max_tokens, and every
    // so many tasks, since a session compacts from the front. What the others
    // did since is drawn from the record, from this agent's last stop; a
    // session that remembers nothing is told about its own tasks too.
    const records = transcript.all();
    // A session resumed from a previous process is not remembered here, but
    // the record remembers it: its last task ran in this very session, so it
    // holds its own work and needs only the rules again, not the account of
    // itself. The mark stands at that task's stop, as it would have.
    const resumed = this.briefed.get(agentId) ?? resumedBriefing(records, agentId, session.sessionId);
    const known = resumed;
    const fresh = known === undefined || known.sessionId !== session.sessionId;
    const first =
      fresh ||
      known.lastStop === 'max_tokens' ||
      // The last task never reached the agent — the process was dying, or the
      // session was replaced under it. What it was told is not known, so it is
      // told again. This is also the case a resumed session lands in: the id
      // is the one from before, so nothing else here would notice.
      known.lastStop === 'unresponsive' ||
      known.tasksSinceRules >= config.limits.rebriefEveryTasks;
    const since = fresh ? floorOf(records) : known.since;
    const handoff = renderHandoff({
      tasks: tasksSince(records, since, options),
      agentId,
      includeOwn: fresh,
      workspaceDir: workspace.dir,
      roleOf: (id) => agentRole(config, id),
      budgetChars: config.limits.handoffBudgetChars,
    });
    const brief = buildBrief({
      task,
      kind,
      doneWhen,
      context,
      workspaceDir: workspace.dir,
      first,
      handoff,
    });

    // The brief is not on the record — the task is, and the rest is rebuilt
    // from the record on demand — so this is the one place to read what an
    // agent was actually sent.
    debug('brief', `task ${taskId} to ${agentId}, ${brief.length} chars:\n${brief}`);

    let stopReason: StopReason | 'unresponsive';
    let usage: TurnUsage | undefined;
    try {
      const end = await session.prompt(brief, {
        turnTimeoutMs: config.limits.turnTimeoutMs,
        idleTimeoutMs: config.limits.idleTimeoutMs,
        cancelGraceMs: config.limits.cancelGraceMs,
        signal,
      });
      stopReason = end.stopReason;
      usage = end.usage;
    } catch (err) {
      stopReason = 'unresponsive';
      transcript.append({
        type: 'note',
        level: 'error',
        text: (err as Error).message,
      });
      if (err instanceof SessionUnresponsiveError) {
        // A session that will not end its turn cannot be trusted with the next
        // one; drop the process so the following task starts clean.
        await pool.discard(agentId);
      }
    }

    const stopped = transcript.append({
      type: 'stop',
      taskId,
      agentId,
      sessionId: session.sessionId,
      stopReason: stopReason === 'unresponsive' ? 'cancelled' : stopReason,
      ...(usage === undefined ? {} : { usage }),
      ...(session.currentModel() === undefined ? {} : { model: session.currentModel() }),
    });
    if (epoch === this.epoch) {
      this.briefed.set(agentId, {
        sessionId: session.sessionId,
        tasksSinceRules: first ? 1 : known.tasksSinceRules + 1,
        lastStop: stopReason,
        // The mark only moves for a brief that was actually delivered. A turn
        // that threw may have died before the prompt went out, and advancing
        // past a handoff nobody read would lose it for good: what the other
        // agents changed would sit forever on the wrong side of the line.
        since: stopReason === 'unresponsive' ? since : stopped.seq,
      });
    }

    return {
      ...summarise(taskId, agentId, task, stopReason, transcript.forTask(taskId), Date.now() - startedAt, options),
      briefChars: brief.length,
    };
  }

  /**
   * The command a line invokes, if it invokes one. `unknown` is a name that
   * could have been a command and was not; a name that could never have been
   * one — a path, mostly — is not a command at all and goes to the model as
   * the ordinary text it is.
   */
  private invoked(text: string): { command: Command; args: string } | 'unknown' | undefined {
    const parsed = parseSlashCommand(text);
    if (!parsed) return undefined;
    const command = findCommand(parsed.name, this.deps.commands);
    if (command) return { command, args: parsed.args };
    return looksLikeCommand(parsed.name) ? 'unknown' : undefined;
  }

  /** A command handsfree answers itself. No agent is woken, no turn is spent. */
  private local(command: CommandBase & LocalCommand, args: string): void {
    const { transcript } = this.deps;
    if (command.interactive) {
      transcript.append({
        type: 'note',
        level: 'warn',
        text: `/${command.name} only means something in the terminal UI.`,
      });
      return;
    }

    const effect = command.run(args, this.deps.commandHost(`/${command.name}`));
    switch (effect.do) {
      case 'say':
        transcript.append({
          type: 'note',
          level: 'info',
          text: effect.text,
          ...(effect.lines ? { lines: effect.lines } : {}),
        });
        break;
      case 'clear':
        this.reset();
        // The mark goes down first so the note is the one row left standing:
        // a screen wiped without a word for it reads as a command that failed,
        // and the line about briefing is the one thing worth keeping anyway.
        transcript.append({ type: 'clear' });
        transcript.append({
          type: 'note',
          level: 'info',
          text: 'context cleared — the agents will be briefed from scratch.',
        });
        break;
      case 'quit':
        // Only reachable where there is no UI to leave; the terminal handles
        // its own departure before a turn is ever started.
        transcript.append({ type: 'note', level: 'warn', text: 'there is nothing to leave here.' });
        break;
    }
  }

  /**
   * The system prompt: the roster and the rules, and nothing that changes
   * during a run. It is set once and then only replaced when it would differ
   * — an agent switched off, a role changed — so an endpoint that caches by
   * prefix keeps it from one turn to the next.
   */
  private ensureSystemPrompt(agents: string[]): void {
    const cards: AgentCard[] = agents.map((id) => ({
      id,
      description: agentRole(this.deps.config, id) || 'coding agent',
    }));
    const system = planSystemPrompt(cards, this.deps.workspace.dir);
    const current = this.messages[0];
    if (current?.role === 'system') {
      if (current.content !== system) this.messages[0] = { role: 'system', content: system };
    } else {
      this.messages.unshift({ role: 'system', content: system });
    }
  }

  /**
   * The run so far, for the head of the user's message: read off the record
   * from the last `/clear` on, so a cleared conversation plans from a clean
   * slate the way it is briefed from one. The roster's other half is here
   * too — what each agent has open — because it is the half that changes.
   * Shortened, oldest tasks first, until it and the system prompt and the
   * line itself fit their share of the planner's budget.
   */
  private runState(agents: string[], prompt: string): string {
    const { config, transcript, workspace } = this.deps;
    const records = transcript.all();
    const tasks = tasksSince(records, floorOf(records), this.ledgerOptions());
    const worked = agentRecords(tasks);
    const sessions = agents.map((id) => ({
      id,
      record: renderAgentRecord(worked.get(id), workspace.dir),
    }));
    const fixed = estimateTokens(this.messages[0]?.content ?? '') + estimateTokens(prompt);
    const budget = Math.floor(contextBudgetTokens(config.orchestration) * STATE_SHARE);
    let shown = LEDGER_TASKS;
    for (;;) {
      const state = renderState(sessions, renderRunState(tasks, workspace.dir, shown));
      if (fixed + estimateTokens(state) <= budget || shown <= 2) return state;
      shown = Math.max(2, Math.floor(shown / 2));
    }
  }
}

/**
 * What a session read back off the record is known to have heard, for an
 * agent this process has not briefed yet. Its last task's stop is the mark;
 * the rules are sent again, since a session that has been away may have
 * compacted them — `tasksSinceRules` at the limit says so.
 */
function resumedBriefing(
  records: readonly import('../workspace/transcript.js').TranscriptRecord[],
  agentId: string,
  sessionId: string,
): Briefing | undefined {
  for (let at = records.length - 1; at >= 0; at--) {
    const record = records[at]!;
    if (record.type !== 'stop' || record.agentId !== agentId) continue;
    if (record.sessionId !== sessionId) return undefined;
    return {
      sessionId,
      tasksSinceRules: Number.MAX_SAFE_INTEGER,
      lastStop: record.stopReason,
      since: record.seq,
    };
  }
  return undefined;
}
