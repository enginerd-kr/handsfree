import { agentRole, plannerLabel, type Config } from '../../config/schema.js';
import {
  type ChatClient,
  type ChatMessage,
} from '../../models/client.js';
import type { OrchestrationChoice } from '../../models/planner.js';
import { renderLedger } from './narrate.js';
import {
  composeUserMessage,
  nextStep,
  planSystemPrompt,
  renderState,
  type AnswerStream,
} from './plan.js';
import type { AgentPool } from '../../host/pool.js';
import { AgentTool, type AgentCard } from './tools/agent.js';
import { Toolbox, renderToolResult, toolError, type Tool, type ToolResult } from './tools/tool.js';
import type { Transcript } from '../../workspace/transcript.js';
import type { Workspace } from '../../workspace/workspace.js';
import { expandBody } from './commands/expand.js';
import {
  findCommand,
  looksLikeCommand,
  parseSlashCommand,
  type Command,
  type CommandBase,
  type CommandHost,
  type LocalCommand,
} from './commands/command.js';
import { parseMention, parseOrchestration } from './mention.js';
import { Delegator } from '../execution/delegate.js';
import { agentRecords, renderAgentRecord, renderRunState } from '../context/ledger.js';
import type { TaskOutcome } from '../results/outcome.js';
import { metered } from '../usage/usage.js';
import type { Executor } from '../execution/executor.js';
import type { UsageTracker } from '../usage/meter.js';
import { ResultTool } from './tools/result.js';
import { ContextTool } from './tools/context.js';
import { RunContext } from '../context/context.js';
import { WorkMode } from '../context/work-mode.js';
import { PlanTool } from './tools/plan.js';
import { AgentJobs } from './jobs.js';
import { JobTool } from './tools/job.js';
import { recoverWindow } from './window.js';
import { SharedConversations } from '../context/shared.js';
import { SharedContextTool } from './tools/shared.js';

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
    const stream = this.open ? { stream: this.id } : {};
    this.open = false;
    this.transcript.append({ type: 'assistant', ...stream, text, ...(ledger ? { ledger: true } : {}) });
  }
}

export class Conversation {
  private messages: ChatMessage[] = [];
  private streamCounter = 0;
  private turn: AbortController | undefined;
  private inflight: Promise<void> | undefined;
  private finishing = false;
  private readonly updates: string[] = [];
  private wake = new AbortController();
  private readonly jobs: AgentJobs;
  private readonly delegator: Delegator;
  /** What the planner can call: the agent tool, and whatever else was handed in. */
  private readonly toolbox: Toolbox;
  private readonly context: RunContext;
  private readonly shared: SharedConversations;
  private readonly workMode: WorkMode;
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
    this.shared = new SharedConversations(deps.transcript);
    this.workMode = new WorkMode(deps.transcript, deps.workspace.runDir);
    this.jobs = new AgentJobs(deps.transcript);
    this.messages = this.context.history();
    const agent = new AgentTool({
      jobs: this.jobs,
      roster: () => this.roster(),
      delegator: this.delegator,
      transcript: deps.transcript,
      workspace: deps.workspace,
      onOutcome: (outcome) => deps.executor?.store(outcome),
      readOutcome: deps.executor ? (taskId) => deps.executor!.readOutcome(taskId) : undefined,
      taskRefs: () => this.context.taskRefs(),
      shared: deps.executor ? this.shared : undefined,
    });
    this.toolbox = new Toolbox([
      agent,
      new JobTool(this.jobs, agent),
      ...(deps.executor ? [new ResultTool(deps.executor, () => this.context.taskRefs())] : []),
      new ContextTool(this.context),
      ...(deps.executor ? [new SharedContextTool(this.shared)] : []),
      new PlanTool(this.workMode),
      ...(deps.tools ?? []),
    ]);
  }

  get isBusy(): boolean {
    return this.turn !== undefined;
  }

  get mode(): 'plan' | 'execute' { return this.workMode.state().mode; }

  cancel(): void {
    this.turn?.abort();
  }

  reset(): void {
    this.epoch++;
    this.messages = [];
    this.updates.length = 0;
    this.jobs.reset();
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
    await this.jobs.close();
  }

  async send(text: string, shown?: string): Promise<void> {
    if (this.turn?.signal.aborted || this.finishing) {
      await this.inflight;
      return this.send(text, shown);
    }
    const parsed = this.invoked(text);
    if (this.isBusy && !parsed) {
      this.deps.transcript.append({ type: 'user', text, ...(shown === undefined ? {} : { shown }) });
      this.updates.push(text);
      this.wake.abort();
      await this.inflight;
      return;
    }
    if (this.isBusy && !(parsed && parsed !== 'unknown' && parsed.command.kind === 'local')) throw new Error('Prompt commands must wait for the current turn.');
    if (this.isBusy) { await this.run(text, shown); return; }
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
    let invoked = this.invoked(text);
    transcript.append(said);
    if (invoked === 'unknown') {
      transcript.append({
        type: 'note',
        level: 'error',
        text: `no such command as ${text.trim().split(/\s/)[0]}. /help lists the ones there are.`,
      });
      return;
    }

    if (invoked && invoked.command.kind === 'local') {
      const continuation = this.local(invoked.command, invoked.args);
      if (!continuation) return;
      text = continuation;
      invoked = undefined;
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
    let recoveredWindow = false;
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
    let completion: 'reported' | 'cancelled' | 'error' = 'error';
    const epoch = this.epoch;
    let history: ChatMessage[] = this.messages;
    const consumeUpdates = () => {
      for (const update of this.updates.splice(0)) {
        if (turnId !== undefined) {
          this.context.update(turnId, update);
          this.shared.update(turnId);
        }
        history.push({ role: 'user', pinned: true, content: `USER UPDATE:\n${update}` });
        if (opening) opening = { ...opening, content: `${opening.content}\n\nUSER UPDATE:\n${update}` };
      }
      this.wake = new AbortController();
    };
    const rememberResult = (result: ToolResult) => {
      for (const outcome of [...(result.outcomes ?? []), ...(result.outcome ? [result.outcome] : [])]) {
        if (!outcomes.some((saved) => saved.taskId === outcome.taskId)) outcomes.push(outcome);
      }
      if (result.note && !notes.includes(result.note)) notes.push(result.note);
    };

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
        const routed = this.toolbox.parse(
          JSON.stringify({
            action: 'call',
            tool: 'agent',
            input: {
              agent: mention.agent,
              kind: this.mode === 'plan' ? 'inspect' : 'change',
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
        const result = await routed.step.call.run({ signal: turn.signal, turnId, workMode: this.mode });
        if (result.outcome) outcomes.push(result.outcome);
        if (result.note) notes.push(result.note);
        this.context.retainEvidence(turnId, routed.step.call.json, renderToolResult(result));
        history.push({ role: 'user', content: this.relay(routed.step.call.name, result),
          agents: result.outcome ? [result.outcome.agentId] : [] });
        completion = 'reported';
        if (!this.updates.length) return;
      }

      for (;;) {
        if (turn.signal.aborted) break;
        consumeUpdates();
        for (const result of this.jobs.notifications()) {
          rememberResult(result);
          history.push({ role: 'user', content: this.relay('agent_job notification', result),
            agents: [...(result.outcomes ?? []), ...(result.outcome ? [result.outcome] : [])].map((outcome) => outcome.agentId) });
        }

        // Rebuild from durable state after every result or self-analysis.
        // Replace, never mutate, a message a previous model call may retain.
        if (epoch === this.epoch) {
          const at = history.indexOf(sent);
          sent = this.requestMessage(agents, prompt, turnId);
          if (recoveredWindow) sent = { ...sent, content: sent.requiredContent! };
          if (at >= 0) history[at] = sent;
        }

        const stream = this.newStream();
        const planned = await this.plan(history, turn.signal, stream, (messages) => {
          const checkpoint = this.context.checkpoint(turnId!, messages);
          const recovered = recoverWindow(messages, checkpoint);
          if (recovered) {
            recoveredWindow = true;
            // Replace the active view as well, so the next step does not send
            // the same overflowing history again. Original records remain.
            history = recovered;
            sent = history.find((message) => message.pinned)!;
            transcript.append({ type: 'note', level: 'info', text: `Recovered the model context from checkpoint ${checkpoint}; original evidence remains in the run record.` });
          }
          return recovered;
        });
        if (!planned.ok) {
          stream.retract();
          if (this.updates.length && !turn.signal.aborted) continue;
          notes.push(`The orchestration model did not produce a usable next step (${planned.error}).`);
          completion = 'error';
          break;
        }
        if (planned.step.review && !this.updates.length) this.context.review(turnId, planned.step.review);

        if (planned.step.action === 'answer' && !this.updates.length && (this.jobs.running || this.jobs.pending)) {
          stream.retract();
          await this.jobs.wait([], { signal: turn.signal, wakeSignal: this.wake.signal });
          continue;
        }
        if (planned.step.action === 'answer' && !this.updates.length) {
          history.push({ role: 'assistant', content: JSON.stringify(planned.step) });
          const message = planned.step.message;
          this.context.step(turnId, JSON.stringify(planned.step));
          stream.end(message);
          answered = true;
          completion = 'reported';
          closing = message;
          break;
        }
        const step = planned.step;
        if (step.action === 'answer') { stream.retract(); continue; }
        if (step.action === 'continue' && step.message && !this.updates.length) stream.end(step.message);
        else stream.retract();
        const calls = step.action === 'call' ? [step.call] : step.calls;
        const json = step.action === 'call' ? step.call.json : JSON.stringify({
          message: step.message, calls: calls.map((call) => JSON.parse(call.json)), finish: false,
        });
        history.push({ role: 'assistant', content: json });
        this.context.step(turnId, json);
        let halted = false;
        for (const [index, call] of calls.entries()) {
          const skipped: boolean = turn.signal.aborted || halted || this.updates.length > 0;
          let result: ToolResult;
          try {
            result = skipped ? toolError('skipped', 'Not executed: cancelled or superseded by a user update. Reassess before calling again.')
              : await call.run({ signal: turn.signal, turnId, workMode: this.mode, wakeSignal: this.wake.signal });
          } catch (err) {
            result = toolError('tool_exception', `Tool error: ${(err as Error).message}`, null);
          }
          this.context.retainEvidence(turnId, call.json, renderToolResult(result));
          rememberResult(result);
          history.push({ role: 'user', content: this.relay(call.name, result, calls.length > 1 ? index + 1 : undefined),
            agents: [...(result.outcomes ?? []), ...(result.outcome ? [result.outcome] : [])].map((outcome) => outcome.agentId) });
          halted ||= result.halt === true;
        }
        if (halted && !this.updates.length) break;
      }
    } catch (err) {
      completion = 'error';
      if (!turn.signal.aborted) notes.push(`The turn stopped: ${(err as Error).message}`);
    } finally {
      this.finishing = true;
      // A stopped planner must not leave unobserved workers running.
      if (this.jobs.running) await this.jobs.close();
      for (const result of this.jobs.notifications()) rememberResult(result);
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
        closing = renderLedger({ userMessage: prompt, outcomes, notes, workspaceDir: workspace.dir });
        stream.end(closing, true);
      }
      consumeUpdates();
      if (turnId !== undefined) this.context.finish(turnId, turn.signal.aborted ? 'cancelled' : completion,
        closing ?? '');
      if (sent && opening) this.settle(epoch, history, sent, opening, closing);
      this.turn = undefined;
      this.finishing = false;
    }
  }

  /**
   * What the planner is handed when a call ends, under a heading that names
   * the tool. The complete text is retained.
   */
  private relay(tool: string, result: ToolResult, call?: number): string {
    return `TOOL RESULT (${tool})\n${call === undefined ? '' : `Call ${call}:\n`}${renderToolResult(result)}`;
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
    // Keep every historical reply in the same JSON shape the planner emits.
    const reply = JSON.stringify({ action: 'answer', message: closing ?? '(stopped before finishing)' });
    // A new array rather than a splice: the one being replaced was handed to
    // the planner on every step of this turn, and a client that kept it —
    // anything queueing, retrying or recording — must keep what it was sent.
    this.messages = [...history.slice(0, at), opening, { role: 'assistant', content: reply }];
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

  private async plan(history: readonly ChatMessage[], signal: AbortSignal, stream: AnswerStream,
    recoverContext?: (messages: ChatMessage[]) => ChatMessage[] | undefined) {
    if (!this.deps.llm) {
      return { ok: false as const, error: 'no orchestration model is configured' };
    }
    try {
      const llm = metered(this.deps.llm, 'plan', this.deps.transcript, plannerLabel(this.deps.config), this.plannerMeter());
      return await nextStep(llm, [...history], this.toolbox, signal, stream, recoverContext);
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }

  private newStream(): AssistantStream {
    return new AssistantStream(this.deps.transcript, ++this.streamCounter);
  }

  private plannerMeter() {
    return this.deps.usage ? { manager: this.deps.usage,
      frontier: this.deps.config.orchestration.provider !== 'local' } : undefined;
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
  private local(command: CommandBase & LocalCommand, args: string): string | undefined {
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
      case 'work-mode': {
        this.workMode.select(effect.mode);
        transcript.append({ type: 'note', level: 'info', text: `Work mode: ${effect.mode}.` });
        const prompt = effect.prompt || (effect.mode === 'execute' && this.workMode.state().plan
          ? 'Execute the saved plan, incorporating the current user instructions.' : '');
        if (this.isBusy) {
          this.updates.push(`Work mode is now ${effect.mode}. ${prompt}`);
          this.wake.abort();
          return;
        }
        return prompt || undefined;
      }
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
   */
  private requestMessage(agents: string[], prompt: string, turnId: number): ChatMessage {
    const required = [`CURRENT REQUEST SOURCE: record:${turnId}`, this.workMode.prompt(), this.context.required()].filter(Boolean).join('\n');
    return { role: 'user', pinned: true,
      content: composeUserMessage([required, this.runState(agents, turnId)].filter(Boolean).join('\n\n'), prompt),
      requiredContent: composeUserMessage(required, prompt) };
  }

  private runState(agents: string[], turnId: number): string {
    const { workspace } = this.deps;
    const tasks = this.context.tasks(this.delegator.ledgerOptions());
    const worked = agentRecords(tasks);
    const sessions = agents.map((id) => ({
      id,
      record: renderAgentRecord(worked.get(id), workspace.dir),
    }));
    return [renderState(sessions, renderRunState(tasks, workspace.dir, { repliesBefore: turnId })),
      this.context.sources(), this.context.findings(),
      ...(this.shared.list().length ? [`SHARED CONVERSATIONS: ${JSON.stringify(this.shared.list())}`] : [])].filter(Boolean).join('\n');
  }
}
