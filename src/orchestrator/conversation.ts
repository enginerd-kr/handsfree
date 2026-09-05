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
  type AnswerStream,
} from '../brain/plan.js';
import type { AgentPool } from '../host/pool.js';
import { AgentTool, type AgentCard } from '../tools/agent.js';
import { Toolbox, type Tool } from '../tools/tool.js';
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
import { Delegator } from './delegate.js';
import { agentRecords, LEDGER_TASKS, renderAgentRecord, renderRunState } from './ledger.js';
import type { TaskOutcome } from './outcome.js';
import { metered } from './usage.js';
import type { Executor } from './executor.js';
import type { UsageTracker } from './meter.js';
import { ResultTool } from '../tools/result.js';
import { ContextTool } from '../tools/context.js';
import { RunContext } from './context.js';
import { nextItem } from './review.js';

/**
 * How much of the planner's budget the system prompt, the run state and the
 * user's line may take between them before the run state is shortened. The
 * rest is for the history, and for the steps a turn adds as it goes.
 */
const STATE_SHARE = 0.6;

export interface ConversationDeps {
  executor?: Executor;
  usage?: UsageTracker;
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
  /**
   * Tools the planner may call besides the agent tool, which every
   * conversation has. Mostly for tests, which prove the box is generic by
   * putting something else in it.
   */
  tools?: readonly Tool<never>[];
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

export class Conversation {
  private messages: ChatMessage[] = [];
  private streamCounter = 0;
  private turn: AbortController | undefined;
  private inflight: Promise<void> | undefined;
  private readonly delegator: Delegator;
  /** What the planner can call: the agent tool, and whatever else was handed in. */
  private readonly toolbox: Toolbox;
  private readonly context: RunContext;
  /**
   * Which conversation this is. `/clear` does not queue behind a turn — it is
   * over the moment it runs — so a turn can outlive the history it was
   * started against. Everything that writes back into that history checks the
   * epoch it began under first, and an orphaned turn finishes, reports, and
   * leaves no trace in the conversation that replaced it.
   */
  private epoch = 0;

  constructor(private readonly deps: ConversationDeps) {
    // A run read back off its file has replies in it already; the next has
    // to be numbered after them, or the view keys two rows on one id.
    for (const record of deps.transcript.all()) {
      if ((record.type === 'assistant' || record.type === 'assistant_delta') && record.stream !== undefined) {
        this.streamCounter = Math.max(this.streamCounter, record.stream);
      }
    }
    this.delegator = deps.executor?.delegator ?? new Delegator(deps);
    this.context = new RunContext(deps.transcript);
    this.messages = this.context.history(deps.config.orchestration.maxHistoryMessages);
    this.toolbox = new Toolbox([
      new AgentTool({
        roster: () => this.roster(),
        delegator: this.delegator,
        config: deps.config,
        transcript: deps.transcript,
        workspace: deps.workspace,
        onOutcome: (outcome) => deps.executor?.store(outcome),
        workingContext: () => this.context.required(),
      }),
      ...(deps.executor ? [new ResultTool(deps.executor, deps.config.limits.maxResultChars)] : []),
      new ContextTool(this.context, deps.config.limits.maxResultChars),
      ...(deps.tools ?? []),
    ]);
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
    // The ground rules go with the history: the delegator forgets who has
    // been briefed. The stream counter deliberately does not reset: the view
    // keys rows by it, and a second reply 1 would land on the first one's row.
    this.delegator.reset();
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

  async send(text: string, shown?: string): Promise<void> {
    const parsed = this.invoked(text);
    if (this.isBusy && !(parsed && parsed !== 'unknown' && parsed.command.kind === 'local')) throw new Error('A conversation turn is already running');
    const work = this.run(text, shown);
    this.inflight = work;
    try {
      await work;
    } finally {
      if (this.inflight === work) this.inflight = undefined;
    }
  }

  private async run(text: string, shown?: string): Promise<void> {
    const { config, transcript, workspace } = this.deps;
    const said = { type: 'user' as const, text, ...(shown === undefined ? {} : { shown }) };

    // A command is answered before the agent roster is even consulted:
    // `/help` and `/config` are wanted most on exactly the machine where
    // nothing is configured yet.
    const invoked = this.invoked(text);
    if (invoked === 'unknown') {
      transcript.append(said);
      transcript.append({
        type: 'note',
        level: 'error',
        text: `no such command as ${text.trim().split(/\s/)[0]}. /help lists the ones there are.`,
      });
      return;
    }

    transcript.append(said);

    if (invoked && invoked.command.kind === 'local') {
      this.local(invoked.command, invoked.args);
      return;
    }

    const agents = this.deps.pool.available();

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
     * Only a direct @mention closes on the ledger: the named agent owns
     * that reply. Planner-routed tasks return to the planner for follow-up
     * work or a final answer, including calls to a group of agents.
     */
    let ledgerOnly = false;
    let calls = 0;
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
    let turnId: number | undefined;
    let completion: 'reported' | 'cancelled' | 'limited' | 'error' = 'limited';
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
      this.ensureSystemPrompt();
      turnId = this.context.start(prompt);
      // The turn holds the history it was started against, rather than
      // reaching for `this.messages` each time it has something to add. A
      // `/clear` mid-turn puts a new array there, and a turn that followed it
      // would go on planning against a conversation with no system prompt in
      // it — the one thing it must never be asked to do.
      history = this.messages;
      opening = { role: 'user', content: prompt };
      sent = this.requestMessage(agents, prompt, turnId);
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
        calls++;
        const routed = this.toolbox.parse(
          JSON.stringify({
            action: 'call',
            tool: 'agent',
            input: {
              agent: mention.agent,
              kind: 'change',
              prompt: mention.task,
              ...(mention.model === undefined ? {} : { model: mention.model }),
            },
          }),
        );
        // A mention names an agent the roster has and a task that is not
        // empty, which is all the agent tool asks; a parse that fails here is
        // a bug in one of them, not a line to route.
        if (!routed.ok || routed.step.action !== 'call') throw new Error(routed.ok ? 'not a call' : routed.error);
        history.push({ role: 'assistant', content: routed.step.call.json });
        this.context.step(turnId, routed.step.call.json);
        const result = await routed.step.call.run({ signal: turn.signal, turnId });
        if (result.outcome) outcomes.push(result.outcome);
        if (result.note) notes.push(result.note);
        history.push({ role: 'user', content: this.relay(routed.step.call.name, result.text) });
        completion = 'reported';
        return;
      }

      for (let step = 0; step < config.limits.maxPlanSteps; step++) {
        if (turn.signal.aborted) break;

        // Rebuild from durable state after every result or self-analysis.
        // Replace, never mutate, a message a previous model call may retain.
        if (epoch === this.epoch) {
          const at = history.indexOf(sent);
          sent = this.requestMessage(agents, prompt, turnId);
          if (at >= 0) history[at] = sent;
          // Older step exchanges remain addressable in the run record.
          if (at >= 0 && history.length > at + 3) history = [...history.slice(0, at + 1), ...history.slice(-2)];
        }

        const stream = this.newStream();
        const planned = await this.plan(history, turn.signal, stream);
        if (!planned.ok) {
          stream.retract();
          notes.push(`The orchestration model did not produce a usable next step (${planned.error}).`);
          completion = 'error';
          break;
        }
        if (planned.step.review) this.context.review(turnId, planned.step.review);

        if (planned.step.action === 'answer') {
          history.push({ role: 'assistant', content: JSON.stringify(planned.step) });
          const message = planned.step.message;
          this.context.step(turnId, JSON.stringify(planned.step));
          if (planned.step.review) this.context.complete(turnId, nextItem(planned.step.review));
          stream.end(message);
          answered = true;
          completion = 'reported';
          closing = JSON.stringify({ action: 'answer', message });
          break;
        }
        // The step is a call; anything its JSON streamed was not a reply.
        stream.retract();
        const { call } = planned.step;
        history.push({ role: 'assistant', content: call.json });
        this.context.step(turnId, call.json);
        if (call.name === 'agent' && planned.step.review && this.context.isComplete(turnId, nextItem(planned.step.review))) {
          history.push({ role: 'user', content: this.relay(call.name,
            `The item "${nextItem(planned.step.review)}" has already executed successfully. No worker was called. Review existing results and select remaining work or report the result.`) });
          continue;
        }
        const result = await call.run({ signal: turn.signal, remainingCalls: config.limits.maxDelegationsPerTurn - calls, turnId });
        if (call.name === 'task_result' || call.name === 'context' && !result.completedWork) this.context.retainEvidence(turnId, call.json, result.text);
        calls += result.callsUsed ?? 0;
        if (result.outcome) outcomes.push(result.outcome);
        if (result.outcomes) outcomes.push(...result.outcomes);
        const completed = result.outcomes ?? (result.outcome ? [result.outcome] : []);
        if (planned.step.review && (result.completedWork || completed.length > 0 && !result.note && completed.every((outcome) => outcome.status === 'done'))) {
          this.context.complete(turnId, nextItem(planned.step.review));
        }
        if (result.note && !notes.includes(result.note)) notes.push(result.note);
        history.push({ role: 'user', content: this.relay(call.name, result.text) });

        if (result.halt) break;
      }
    } catch (err) {
      completion = 'error';
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
        if (completion === 'limited') notes.push(`Reached the limit of ${config.limits.maxPlanSteps} planning steps; remaining work must be reviewed before continuing.`);
        const stream = this.newStream();
        const summary = ledgerOnly
          ? {
              text: renderLedger({ userMessage: prompt, outcomes, notes, workspaceDir: workspace.dir }),
              ledger: true,
            }
          : outcomes.length > 0 || notes.length > 0
            ? await narrate(
                this.deps.llm && metered(this.deps.llm, 'narrate', transcript, plannerLabel(config), this.plannerMeter()),
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
      if (turnId !== undefined) this.context.finish(turnId, turn.signal.aborted ? 'cancelled' : completion,
        closing ? (JSON.parse(closing) as { message: string }).message : '');
      if (sent && opening) this.settle(epoch, history, sent, opening, closing);
      this.turn = undefined;
    }
  }

  /**
   * What the planner is handed when a call ends, under a heading that names
   * the tool. The text is the tool's, and already cut to the run's limit.
   */
  private relay(tool: string, text: string): string {
    return `TOOL RESULT (${tool})\n${text}`;
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

  private async plan(history: readonly ChatMessage[], signal: AbortSignal, stream: AnswerStream) {
    if (!this.deps.llm) {
      return { ok: false as const, error: 'no orchestration model is configured' };
    }
    try {
      const llm = metered(this.deps.llm, 'plan', this.deps.transcript, plannerLabel(this.deps.config), this.plannerMeter());
      // Fit the working view without altering the durable source records.
      const budget = contextBudgetTokens(this.deps.config.orchestration);
      return await nextStep(llm, [...history], this.toolbox, signal, stream,
        this.deps.config.orchestration.maxRepairAttempts,
        { contextTokens: budget, outputTokens: this.deps.config.orchestration.maxOutputTokens });
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }

  private newStream(): AssistantStream {
    return new AssistantStream(this.deps.transcript, ++this.streamCounter);
  }

  private plannerMeter() {
    return this.deps.usage ? { manager: this.deps.usage,
      frontier: this.deps.config.orchestration.provider !== 'local',
      contextTokens: contextBudgetTokens(this.deps.config.orchestration),
      outputTokens: this.deps.config.orchestration.maxOutputTokens } : undefined;
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

  /** The agents the planner may call, each with the one line it is told about them. */
  private roster(): AgentCard[] {
    return this.deps.pool.available().map((id) => ({
      id,
      description: agentRole(this.deps.config, id) || 'coding agent',
    }));
  }

  /**
   * The system prompt: the tools and the rules, and nothing that changes
   * during a run. It is set once and then only replaced when it would differ
   * — an agent switched off, a role changed — so an endpoint that caches by
   * prefix keeps it from one turn to the next.
   */
  private ensureSystemPrompt(): void {
    const system = planSystemPrompt(this.toolbox);
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
  private requestMessage(agents: string[], prompt: string, turnId: number): ChatMessage {
    const required = [`CURRENT REQUEST SOURCE: record ${turnId}`, this.context.required()].filter(Boolean).join('\n');
    return { role: 'user', pinned: true,
      content: composeUserMessage([required, this.runState(agents, prompt),
        this.context.evidenceView(turnId, this.deps.config.limits.maxResultChars * 4)].filter(Boolean).join('\n\n'), prompt),
      requiredContent: composeUserMessage(required, prompt) };
  }

  private runState(agents: string[], prompt: string): string {
    const { config, workspace } = this.deps;
    const tasks = this.context.tasks(this.delegator.ledgerOptions());
    const worked = agentRecords(tasks);
    const sessions = agents.map((id) => ({
      id,
      record: renderAgentRecord(worked.get(id), workspace.dir),
    }));
    const fixed = estimateTokens(this.messages[0]?.content ?? '') + estimateTokens(prompt) + estimateTokens(this.context.required());
    const budget = Math.floor(contextBudgetTokens(config.orchestration) * STATE_SHARE);
    let shown = LEDGER_TASKS;
    for (;;) {
      const state = [renderState(sessions, renderRunState(tasks, workspace.dir, shown)),
        this.context.sources(), this.context.findings()].filter(Boolean).join('\n');
      if (fixed + estimateTokens(state) <= budget || shown <= 2) return state;
      shown = Math.max(2, Math.floor(shown / 2));
    }
  }
}
