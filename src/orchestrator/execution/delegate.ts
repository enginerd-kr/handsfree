import type { StopReason } from '@agentclientprotocol/sdk';
import type { Config } from '../../config/schema.js';
import { estimateTokens } from '../../models/client.js';
import type { UsageTracker, UsageLease } from '../usage/meter.js';
import { tokensOf } from '../usage/usage.js';
import type { PolicyEngine } from '../../policy/engine.js';
import { TaskScheduler } from './scheduler.js';
import { remember, sessionMemory } from '../context/memory.js';
import { debug } from '../../debug.js';
import { SessionUnresponsiveError } from '../../host/session.js';
import { type TurnUsage } from '../../contracts/usage.js';
import type { ModelChoice } from '../../host/models.js';
import { type AgentPool, AgentStartError } from '../../host/pool.js';
import type { Transcript, TranscriptRecord } from '../../workspace/transcript.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { LedgerOptions } from '../context/ledger.js';
import { summarise, type TaskOutcome } from '../results/outcome.js';
import { buildBrief, type TaskKind } from './prompts.js';

/**
 * What handsfree remembers about having briefed an agent: which session heard
 * the ground rules and how its last call ended.
 */
interface Briefing {
  sessionId: string;
  lastStop: StopReason | 'unresponsive';
}

export interface DelegatorDeps {
  config: Config;
  pool: AgentPool;
  transcript: Transcript;
  workspace: Workspace;
  usage?: UsageTracker;
  policy?: PolicyEngine;
  scheduler?: TaskScheduler;
}

/** One task, as the planner or an @mention hands it out. */
export interface Delegation {
  agentId: string;
  /** Whether the agent is being asked for words or for a changed workspace. */
  kind: TaskKind;
  /** The brief, as the planner wrote it: what to do, and what done looks like. */
  prompt: string;
  /** Explicitly selected source replies, attached only when building the wire prompt. */
  context?: readonly TaskOutcome[];
  /** A few words naming the task, for the screen. */
  title?: string | undefined;
  /** The model the work should run on, as a mention or the planner named it. */
  model?: string | undefined;
  sessionId?: string;
}

/**
 * Hands one task to one agent and sees it through: the session, the brief
 * with its ground rules and selected sources, the stop on the record, and
 * the outcome read back off it. It also keeps what handsfree remembers about
 * briefing — which session has heard the rules and whether they need to be
 * repeated after an interrupted call.
 */
export class Delegator {
  private readonly scheduler: TaskScheduler;
  private taskCounter = 0;
  private readonly briefed = new Map<string, Briefing>();
  /**
   * Which conversation this is. A `/clear` empties what is remembered about
   * briefing, and a task still running across it must not write its briefing
   * back into the conversation that replaced the one it started in.
   */
  private epoch = 0;

  constructor(private readonly deps: DelegatorDeps) {
    this.scheduler = deps.scheduler ?? new TaskScheduler();
    // A run read back off its file has tasks in it already; the next has to
    // be numbered after them, or the view keys two rows on one id and the
    // ledger reads two tasks as one.
    for (const record of deps.transcript.all()) {
      if ('taskId' in record && record.taskId !== undefined) this.taskCounter = Math.max(this.taskCounter, record.taskId);
    }
  }

  /**
   * The ground rules go with the history. An agent that keeps its session
   * across a clear would otherwise never hear them again, and the first brief
   * after starting over would be the one that explains nothing. The counter
   * deliberately does not reset: the view keys rows by it, and a second task 1
   * would land on the first one's row.
   */
  reset(): void {
    this.epoch++;
    this.briefed.clear();
  }

  /** Workspace used to resolve reported paths. */
  ledgerOptions(): LedgerOptions {
    const { workspace } = this.deps;
    return {
      workspaceDir: workspace.dir,
    };
  }

  estimate(agentId: string, task: string): number {
    const charges = this.deps.transcript.all().filter((r) => r.type === 'budget_usage' && r.usage.source === agentId && r.usage.tokens > 0).slice(-8);
    const counts = charges.map((r) => r.type === 'budget_usage' ? r.usage.tokens : 0).sort((a, b) => a - b);
    const expected = counts.length
      ? counts[Math.ceil(counts.length * 0.9) - 1]!
      : estimateTokens(task);
    const context = sessionMemory(this.deps.transcript, agentId, this.deps.pool.sessionId(agentId)).context?.used ?? 0;
    return Math.ceil(Math.max(estimateTokens(task), expected, context));
  }

  async delegate(delegation: Delegation, signal: AbortSignal): Promise<TaskOutcome> {
    const exclusive = delegation.kind === 'change' || this.deps.pool.usesNativeTools(delegation.agentId);
    const release = await this.scheduler.acquire(delegation.agentId, exclusive, signal);
    const cancel = () => { void this.deps.pool.discard(delegation.agentId); };
    signal.addEventListener('abort', cancel, { once: true });
    try { return await this.perform(delegation, signal); }
    finally { signal.removeEventListener('abort', cancel); release(); }
  }

  private async perform(delegation: Delegation, signal: AbortSignal): Promise<TaskOutcome> {
    const { agentId, kind, prompt: task, title, model } = delegation;
    const { config, pool, transcript, workspace } = this.deps;
    const taskId = ++this.taskCounter;
    const startedAt = Date.now();
    // What is remembered about this agent belongs to the conversation this
    // task was started in. A `/clear` while it runs empties that, and writing
    // the briefing back afterwards would quietly restore a session's claim to
    // have heard rules that were cleared along with everything else.
    const epoch = this.epoch;
    const options = { ...this.ledgerOptions(), kind,
      contextFrom: delegation.context?.map((source) => source.taskId) };

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
    let lease: UsageLease | undefined;
    try {
      if (signal.aborted) return { ...failed(new Error('Cancelled before starting')), status: 'cancelled' };
      const profile = config.agents[agentId];
      lease = this.deps.usage?.begin(agentId, model ?? pool.currentModel(agentId) ?? agentId, profile?.frontier ?? true);
      session = await pool.session(agentId);
      if (delegation.sessionId !== undefined && session.sessionId !== delegation.sessionId) throw new Error(`Session ${delegation.sessionId} is no longer active for ${agentId}`);
      if (model !== undefined) chosen = await session.selectModel(model);
      lease?.setModel(session.currentModel() ?? agentId);
    } catch (err) {
      lease?.finish({ tokens: 0, inputTokens: 0, outputTokens: 0, estimated: true }, true);
      return { ...failed(err), ...(signal.aborted ? { status: 'cancelled' as const } : {}) };
    }

    transcript.append({
      type: 'delegation',
      taskId,
      agentId,
      sessionId: session.sessionId,
      task,
      kind,
      ...(options.contextFrom?.length ? { contextFrom: options.contextFrom } : {}),
      ...(title === undefined ? {} : { title }),
      // The id is what went on the wire, so the id is what is written down.
      ...(chosen === undefined ? {} : { model: chosen.value }),
    });

    // Repeat ground rules for a new or interrupted session. The worker keeps
    // its own session history; all additional result context is explicit.
    const known = this.briefed.get(agentId);
    const fresh = known === undefined || known.sessionId !== session.sessionId;
    const first =
      fresh ||
      known.lastStop === 'max_tokens' ||
      // The last task never reached the agent — the process was dying, or the
      // session was replaced under it. What it was told is not known, so it is
      // told again. This is also the case a resumed session lands in: the id
      // is the one from before, so nothing else here would notice.
      known.lastStop === 'unresponsive';
    const stale = sessionMemory(transcript, agentId, session.sessionId).stale;
    const brief = buildBrief({
      task,
      kind,
      workspaceDir: workspace.dir,
      first,
      context: delegation.context,
      staleFiles: stale,
    });

    // The brief is not on the record — the task is, and the rest is rebuilt
    // from the record on demand — so this is the one place to read what an
    // agent was actually sent.
    debug('brief', `task ${taskId} to ${agentId}, ${brief.length} chars:\n${brief}`);

    let stopReason: StopReason | 'unresponsive';
    let usage: TurnUsage | undefined;
    let output = '';
    let observed = 0;
    const previousUsage = transcript.all().findLast((r) => r.type === 'session_update' && r.agentId === agentId
      && r.sessionId === session.sessionId && r.update.sessionUpdate === 'usage_update');
    const previousCost = previousUsage?.type === 'session_update' && previousUsage.update.sessionUpdate === 'usage_update'
      && previousUsage.update.cost?.currency === 'USD' ? previousUsage.update.cost.amount : 0;
    let costUsd: number | undefined;
    const observe = (record: TranscriptRecord) => {
      if (record.type !== 'session_update' || record.agentId !== agentId || record.sessionId !== session.sessionId) return;
      if (record.update.sessionUpdate === 'agent_message_chunk' || record.update.sessionUpdate === 'agent_thought_chunk') {
        if (record.update.content.type === 'text') output += record.update.content.text;
      }
      // Context size is not billing usage. It is only a conservative lower-bound signal.
      if (record.update.sessionUpdate === 'usage_update') {
        observed = Math.max(observed, record.update.used);
        if (record.update.cost?.currency === 'USD' && record.update.cost.amount >= previousCost) costUsd = record.update.cost.amount - previousCost;
      }
    };
    transcript.on('record', observe);
    try {
      const end = await session.prompt(brief, {
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
    } finally {
      transcript.off('record', observe);
    }

    const outcome = summarise(taskId, agentId, task, stopReason, transcript.forTask(taskId), Date.now() - startedAt, options);
    const charged = lease?.finish({
      tokens: usage ? tokensOf(usage) : Math.max(observed, estimateTokens(brief) + estimateTokens(output)),
      inputTokens: usage?.inputTokens ?? Math.max(observed - estimateTokens(output), estimateTokens(brief)),
      outputTokens: usage ? usage.outputTokens + (usage.thoughtTokens ?? 0) : estimateTokens(output),
      cachedReadTokens: usage?.cachedReadTokens,
      cachedWriteTokens: usage?.cachedWriteTokens,
      estimated: usage === undefined,
      ...(costUsd === undefined ? {} : { costUsd }),
    }, outcome.status !== 'done');
    if (signal.aborted) outcome.status = 'cancelled';
    remember(transcript, outcome, session.sessionId);

    transcript.append({
      type: 'stop',
      taskId,
      agentId,
      sessionId: session.sessionId,
      stopReason,
      status: outcome.status,
      ...(usage === undefined ? {} : { usage }),
      ...(session.currentModel() === undefined ? {} : { model: session.currentModel() }),
    });
    if (epoch === this.epoch) {
      this.briefed.set(agentId, {
        sessionId: session.sessionId,
        lastStop: stopReason,
      });
    }

    return {
      ...outcome,
      briefChars: brief.length,
      usage: charged,
    };
  }
}
