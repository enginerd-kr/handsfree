import type { StopReason } from '@agentclientprotocol/sdk';
import type { Config } from '../config/schema.js';
import { trimHistory, type ChatClient, type ChatMessage } from '../brain/client.js';
import type { OrchestrationChoice } from '../brain/planner.js';
import { narrate } from '../brain/narrate.js';
import { nextStep, planSystemPrompt, type AgentCard, type AnswerStream } from '../brain/plan.js';
import { SessionUnresponsiveError } from '../host/session.js';
import type { ModelChoice } from '../host/models.js';
import type { AgentPool } from '../host/pool.js';
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
import { summarise, renderOutcome, type TaskOutcome } from './outcome.js';
import { buildBrief, type TaskKind } from './prompts.js';

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

  end(text: string): void {
    if (this.open) {
      this.open = false;
      this.transcript.append({ type: 'assistant', stream: this.id, text });
    } else {
      this.transcript.append({ type: 'assistant', text });
    }
  }
}

export class Conversation {
  private messages: ChatMessage[] = [];
  private taskCounter = 0;
  private streamCounter = 0;
  private turn: AbortController | undefined;
  private inflight: Promise<void> | undefined;
  private readonly briefed = new Set<string>();

  constructor(private readonly deps: ConversationDeps) {}

  get isBusy(): boolean {
    return this.turn !== undefined;
  }

  cancel(): void {
    this.turn?.abort();
  }

  reset(): void {
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
    let delegations = 0;

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
      this.push({ role: 'user', content: prompt });

      // A line that leads with "@agent" has already chosen its recipient, so
      // the planner is never consulted: what follows the name is the task,
      // sent as written — and a ":model" suffix on the name is the model the
      // work should run on. The step still goes into the history as the JSON
      // the planner would have written, so the turns after this one read the
      // same conversation whichever way the task was routed.
      const mention = invoked ? undefined : parseMention(prompt, agents);
      if (mention) {
        delegations++;
        this.push({
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
          turn.signal,
          mention.model,
        );
        outcomes.push(outcome);
        this.push({
          role: 'user',
          content: `TASK RESULT\n${renderOutcome(outcome, workspace.dir).slice(0, config.limits.maxResultChars)}`,
        });
        return;
      }

      for (let step = 0; step < config.limits.maxPlanSteps; step++) {
        if (turn.signal.aborted) break;

        const stream = this.newStream();
        const planned = await this.plan(agents, turn.signal, stream);
        if (!planned.ok) {
          stream.retract();
          notes.push(`The orchestration model did not produce a usable next step (${planned.error}).`);
          break;
        }
        this.push({ role: 'assistant', content: JSON.stringify(planned.step) });

        if (planned.step.action === 'answer') {
          stream.end(planned.step.message);
          answered = true;
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
          turn.signal,
        );
        outcomes.push(outcome);
        this.push({
          role: 'user',
          content: `TASK RESULT\n${renderOutcome(outcome, workspace.dir).slice(0, config.limits.maxResultChars)}`,
        });

        if (outcome.status === 'cancelled' || outcome.status === 'error') break;
      }
    } catch (err) {
      if (!turn.signal.aborted) notes.push(`The turn stopped: ${(err as Error).message}`);
    } finally {
      // A cancelled turn ends where it stood, silently: the delegation and
      // stop records already say what ran, and the user asked for a stop, not
      // a report about stopping. Skipping the summary is also what lets /exit
      // end the process instead of waiting on one nobody would read.
      if (!answered && !turn.signal.aborted) {
        const stream = this.newStream();
        const summary =
          outcomes.length > 0 || notes.length > 0
            ? await narrate(
                this.deps.llm,
                { userMessage: prompt, outcomes, notes, workspaceDir: workspace.dir },
                turn.signal,
                (piece) => stream.delta(piece),
              )
            : 'Nothing to do.';
        this.push({ role: 'assistant', content: summary });
        stream.end(summary);
      }
      this.turn = undefined;
    }
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

  private async plan(agents: string[], signal: AbortSignal, stream: AnswerStream) {
    if (!this.deps.llm) {
      return { ok: false as const, error: 'no orchestration model is configured' };
    }
    try {
      return await nextStep(this.deps.llm, this.messages, agents, signal, stream);
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }

  private newStream(): AssistantStream {
    return new AssistantStream(this.deps.transcript, ++this.streamCounter);
  }

  private async delegate(
    agentId: string,
    kind: TaskKind,
    task: string,
    doneWhen: string | undefined,
    signal: AbortSignal,
    model?: string,
  ): Promise<TaskOutcome> {
    const { config, pool, transcript, workspace } = this.deps;
    const taskId = ++this.taskCounter;
    const startedAt = Date.now();

    const failed = (err: unknown): TaskOutcome => {
      const outcome = summarise(taskId, agentId, task, 'unresponsive', [], Date.now() - startedAt);
      transcript.append({ type: 'note', level: 'error', text: (err as Error).message });
      return { ...outcome, message: (err as Error).message };
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

    const first = !this.briefed.has(agentId);
    this.briefed.add(agentId);
    const brief = buildBrief({ task, kind, doneWhen, workspaceDir: workspace.dir, first });

    let stopReason: StopReason | 'unresponsive';
    try {
      stopReason = await session.prompt(brief, {
        turnTimeoutMs: config.limits.turnTimeoutMs,
        idleTimeoutMs: config.limits.idleTimeoutMs,
        cancelGraceMs: config.limits.cancelGraceMs,
        signal,
      });
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

    transcript.append({
      type: 'stop',
      taskId,
      agentId,
      sessionId: session.sessionId,
      stopReason: stopReason === 'unresponsive' ? 'cancelled' : stopReason,
    });

    return summarise(
      taskId,
      agentId,
      task,
      stopReason,
      transcript.forTask(taskId),
      Date.now() - startedAt,
    );
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

  private ensureSystemPrompt(agents: string[]): void {
    const cards: AgentCard[] = agents.map((id) => ({
      id,
      description: this.deps.config.agents[id]?.note || 'coding agent',
    }));
    const system = planSystemPrompt(cards, this.deps.workspace.dir);
    if (this.messages[0]?.role === 'system') this.messages[0] = { role: 'system', content: system };
    else this.messages.unshift({ role: 'system', content: system });
  }

  private push(message: ChatMessage): void {
    this.messages.push(message);
    this.messages = trimHistory(this.messages, this.deps.config.orchestration.maxHistoryMessages);
  }
}
