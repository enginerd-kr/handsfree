import type { StopReason } from '@agentclientprotocol/sdk';
import { agentRole, type Config } from '../config/schema.js';
import { debug } from '../debug.js';
import { SessionUnresponsiveError, type TurnUsage } from '../host/session.js';
import type { ModelChoice } from '../host/models.js';
import { type AgentPool, AgentStartError } from '../host/pool.js';
import type { Transcript, TranscriptRecord } from '../workspace/transcript.js';
import type { Workspace } from '../workspace/workspace.js';
import { floorOf, renderHandoff, tasksSince, type LedgerOptions } from './ledger.js';
import { summarise, type TaskOutcome } from './outcome.js';
import { buildBrief, type TaskKind } from './prompts.js';
import { DEFAULT_REPORT_LIMITS } from './report.js';

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

export interface DelegatorDeps {
  config: Config;
  pool: AgentPool;
  transcript: Transcript;
  workspace: Workspace;
}

/** One task, as the planner or an @mention hands it out. */
export interface Delegation {
  agentId: string;
  /** Whether the agent is being asked for words or for a changed workspace. */
  kind: TaskKind;
  /** The brief, as the planner wrote it: what to do, and what done looks like. */
  prompt: string;
  /** A few words naming the task, for the screen. */
  title?: string | undefined;
  /** The model the work should run on, as a mention or the planner named it. */
  model?: string | undefined;
}

/**
 * Hands one task to one agent and sees it through: the session, the brief
 * with its ground rules and handoff, the prompt, the stop on the record, and
 * the outcome read back off it. It also keeps what handsfree remembers about
 * briefing — which session has heard the rules, and where its last task
 * stopped — because that is what decides how the next brief is written.
 */
export class Delegator {
  private taskCounter = 0;
  private readonly briefed = new Map<string, Briefing>();
  /**
   * Which conversation this is. A `/clear` empties what is remembered about
   * briefing, and a task still running across it must not write its briefing
   * back into the conversation that replaced the one it started in.
   */
  private epoch = 0;

  constructor(private readonly deps: DelegatorDeps) {
    // A run read back off its file has tasks in it already; the next has to
    // be numbered after them, or the view keys two rows on one id and the
    // ledger reads two tasks as one.
    for (const record of deps.transcript.all()) {
      if (record.type === 'delegation') this.taskCounter = Math.max(this.taskCounter, record.taskId);
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

  /** How the record is read into outcomes: where the workspace is, how long a summary may be. */
  ledgerOptions(): LedgerOptions {
    const { config, workspace } = this.deps;
    return {
      workspaceDir: workspace.dir,
      report: { ...DEFAULT_REPORT_LIMITS, summaryChars: config.limits.reportSummaryChars },
    };
  }

  async delegate(delegation: Delegation, signal: AbortSignal): Promise<TaskOutcome> {
    const { agentId, kind, prompt: task, title, model } = delegation;
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
      ...(title === undefined ? {} : { title }),
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
    const known = this.briefed.get(agentId) ?? resumedBriefing(records, agentId, session.sessionId);
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
}

/**
 * What a session read back off the record is known to have heard, for an
 * agent this process has not briefed yet. Its last task's stop is the mark;
 * the rules are sent again, since a session that has been away may have
 * compacted them — `tasksSinceRules` at the limit says so.
 */
function resumedBriefing(
  records: readonly TranscriptRecord[],
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
