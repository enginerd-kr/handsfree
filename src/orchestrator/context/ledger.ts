import { taskRecords, type TranscriptRecord } from '../../workspace/transcript.js';
import { relative, renderOutcomeHead, summarise, type TaskOutcome } from '../results/outcome.js';
import { oneLine } from '../results/report.js';

/** A finished task as the transcript tells it, with where in the record it ended. */
export interface LedgerTask {
  outcome: TaskOutcome;
  /** The seq of the task's `stop` record: what "since" is measured against. */
  seq: number;
  /** The session it ran in, so a record can say what *this* session is holding. */
  sessionId: string;
  resolved?: boolean;
}


/**
 * The seq everything before which is history: the last `/clear`, or the start
 * of the record. A conversation cleared is briefed from scratch, and a ledger
 * that remembered across the line would brief it from the middle.
 */
export function floorOf(records: readonly TranscriptRecord[]): number {
  for (let at = records.length - 1; at >= 0; at--) {
    const record = records[at]!;
    if (record.type === 'clear') return record.seq;
  }
  return 0;
}

export interface LedgerOptions {
  workspaceDir?: string;
}

/**
 * Every task that has finished since `after`, oldest first, rebuilt from the
 * record the same way the planner was told about it the first time. Nothing
 * here is remembered in a second place: a restart that replays the file, or a
 * test that fabricates one, sees the same ledger the live run did.
 *
 * A task belongs to the period it was *handed out* in, not the one it happened
 * to finish in. `/clear` can land in the middle of a running task, and a ledger
 * keyed on the stop would keep exactly that one task and drop everything
 * around it — a clean slate with a single stranger standing on it.
 */
export function tasksSince(
  records: readonly TranscriptRecord[],
  after: number,
  options: LedgerOptions = {},
): LedgerTask[] {
  const open = new Map<number, { at: number; startedAt: number; seq: number }>();
  const tasks: LedgerTask[] = [];
  const resolvedTasks = new Set(records.flatMap((r) => r.type === 'resolved' ? r.taskIds : []));
  for (let at = 0; at < records.length; at++) {
    const record = records[at]!;
    if (record.type === 'delegation') {
      open.set(record.taskId, { at, startedAt: record.at, seq: record.seq });
      continue;
    }
    if (record.type !== 'stop') continue;
    const start = open.get(record.taskId);
    open.delete(record.taskId);
    if (!start || start.seq <= after) continue;
    const slice = records.slice(start.at, at + 1);
    const delegation = slice[0];
    if (delegation?.type !== 'delegation') continue;
    const outcome = summarise(record.taskId, record.agentId, delegation.task, record.stopReason,
      taskRecords(slice, delegation), record.at - start.startedAt,
      { ...options, kind: delegation.kind, contextFrom: delegation.contextFrom });
    if (record.status) outcome.status = record.status;
    tasks.push({
      seq: record.seq,
      sessionId: record.sessionId,
      outcome,
      ...(resolvedTasks.has(record.taskId) ? { resolved: true } : {}),
    });
  }
  return tasks;
}

/**
 * What the planner is told about the run so far, in place of the raw exchanges
 * it used to keep: a line per task and the files that are different for it.
 * Built from the record by code, so it costs nothing to produce and never
 * drifts from what happened — a model summarising its own history would do
 * both. All recorded tasks are included.
 */
export function renderRunState(
  tasks: readonly LedgerTask[],
  workspaceDir: string,
  options: { repliesBefore?: number } = {},
): string {
  if (tasks.length === 0) return '';
  const lines: string[] = [];
  for (const { outcome, seq } of tasks) {
    lines.push(renderOutcomeHead(outcome, workspaceDir));
    lines.push(`  task: ${oneLine(outcome.task)}`);
    if (outcome.contextFrom?.length) lines.push(`  context from tasks: ${outcome.contextFrom.join(', ')}`);
    // The agent's own word on it, where it differs from the protocol's: a turn
    // that ended cleanly but says "blocked" is one the planner should not
    // build on as if it were done.
    const { report } = outcome;
    if (report.outcome && report.outcome !== 'done') {
      lines.push(`  agent says: ${report.outcome}`);
    }
    // What the agent said, in its own summary: the one thing the planner
    // would otherwise keep nothing of. The turn that ran the task folds to
    // the user's line and the planner's closing sentence once it is over, so
    // without this a "yes" to "want to hear more?" lands on a planner that
    // no longer knows what there was more of.
    // Replies from the active turn already appear in tool results. Keep the
    // index useful without repeating those answers inside the run state.
    if (report.summary && (options.repliesBefore === undefined || seq < options.repliesBefore)) {
      lines.push(`  said: ${oneLine(report.summary)}`);
    }
  }
  const changed = new Set<string>();
  for (const { outcome } of tasks) {
    for (const file of outcome.changed) changed.add(relative(file, workspaceDir));
  }
  if (changed.size > 0) lines.push(`Files changed this run: ${[...changed].join(', ')}`);
  return lines.join('\n');
}

/** What one agent has done this run, for the line the planner picks it from. */
export interface AgentRecord {
  tasks: number;
  /** Files its session has seen — read or changed — in the order they turned up. */
  files: string[];
  /** Whether anything it was asked to do did not come back done. */
  trouble: boolean;
}

/**
 * The run so far, per agent. This is what makes a role actionable at the moment
 * of choosing: the role says what an agent is for, and this says what it
 * already has loaded — and an agent that has the files a task concerns is the
 * one that needs to read the least to do it.
 */
export function agentRecords(tasks: readonly LedgerTask[]): Map<string, AgentRecord> {
  const records = new Map<string, AgentRecord>();
  // Later tasks overwrite earlier sessions for the same agent.
  const live = new Map(tasks.map(({ outcome, sessionId }) => [outcome.agentId, sessionId]));
  for (const { outcome, sessionId } of tasks) {
    const record = records.get(outcome.agentId) ?? { tasks: 0, files: [], trouble: false };
    record.tasks++;
    if (outcome.status !== 'done') record.trouble = true;
    // Only what the session it is on has seen. A session that had to be
    // replaced took its context with it, and a roster line claiming the new
    // one already has those files open would send work to an agent that would
    // have to read them all over again.
    if (sessionId === live.get(outcome.agentId)) {
      for (const file of outcome.files) {
        if (!record.files.includes(file)) record.files.push(file);
      }
    }
    records.set(outcome.agentId, record);
  }
  return records;
}

/**
 * An agent's record as the roster says it: how much it has done and what its
 * session is therefore holding. Empty for an agent that has not worked yet —
 * a roster line saying so would be a line about nothing.
 */
export function renderAgentRecord(record: AgentRecord | undefined, workspaceDir: string): string {
  if (!record) return '';
  const shown = record.files.map((file) => relative(file, workspaceDir));
  const parts = [`${record.tasks} task${record.tasks === 1 ? '' : 's'} this run`];
  if (shown.length > 0) {
    parts.push(`previously saw ${shown.join(', ')}`);
  }
  if (record.trouble) parts.push('one of them did not finish');
  return parts.join('; ');
}
