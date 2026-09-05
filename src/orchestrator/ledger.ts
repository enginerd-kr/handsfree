import { taskRecords, type TranscriptRecord } from '../workspace/transcript.js';
import { relative, renderOutcomeHead, summarise, type TaskOutcome } from './outcome.js';
import { oneLine, type ReportLimits } from './report.js';

/** A finished task as the transcript tells it, with where in the record it ended. */
export interface LedgerTask {
  outcome: TaskOutcome;
  /** The seq of the task's `stop` record: what "since" is measured against. */
  seq: number;
  /** The session it ran in, so a record can say what *this* session is holding. */
  sessionId: string;
  resolved?: boolean;
}

/** How many tasks the run state spells out before older ones become a count. */
export const LEDGER_TASKS = 24;
/** How much of an agent's summary the next agent, and the run state, carry. */
const HANDOFF_SUMMARY_CHARS = 200;
/** How many files a roster line names before the rest become a count. */
const SESSION_FILES = 6;

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
  report?: ReportLimits;
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
      taskRecords(slice, delegation), record.at - start.startedAt, options);
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
 * both. `maxTasks` is how many are spelled out; the budget the planner runs
 * under decides it, and the rest become a count.
 */
export function renderRunState(
  tasks: readonly LedgerTask[],
  workspaceDir: string,
  maxTasks = LEDGER_TASKS,
): string {
  if (tasks.length === 0) return '';
  const shown = tasks.slice(-Math.max(1, maxTasks));
  const lines: string[] = [];
  const dropped = tasks.length - shown.length;
  if (dropped > 0) {
    const byAgent = new Map<string, number>();
    for (const task of tasks.slice(0, dropped)) {
      byAgent.set(task.outcome.agentId, (byAgent.get(task.outcome.agentId) ?? 0) + 1);
    }
    const who = [...byAgent].map(([agent, count]) => `${count} by ${agent}`).join(', ');
    lines.push(`…${dropped} earlier tasks not listed (${who}).`);
  }
  for (const { outcome } of shown) {
    lines.push(renderOutcomeHead(outcome, workspaceDir));
    lines.push(`  task: ${oneLine(outcome.task, 160)}`);
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
    if (report.summary) lines.push(`  said: ${oneLine(report.summary, HANDOFF_SUMMARY_CHARS)}`);
  }
  const changed = new Set<string>();
  for (const { outcome } of tasks) {
    for (const file of outcome.changed) changed.add(relative(file, workspaceDir));
  }
  if (changed.size > 0) lines.push(`Files changed this run: ${[...changed].slice(-24).join(', ')}${changed.size > 24 ? ` (+${changed.size - 24} others)` : ''}`);
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
 * The session an agent is on now, as the record has it: the one its most
 * recent task ran in. What an earlier session read is not what this one holds.
 */
function currentSession(tasks: readonly LedgerTask[], agentId: string): string | undefined {
  for (let at = tasks.length - 1; at >= 0; at--) {
    if (tasks[at]!.outcome.agentId === agentId) return tasks[at]!.sessionId;
  }
  return undefined;
}

/**
 * The run so far, per agent. This is what makes a role actionable at the moment
 * of choosing: the role says what an agent is for, and this says what it
 * already has loaded — and an agent that has the files a task concerns is the
 * one that needs to read the least to do it.
 */
export function agentRecords(tasks: readonly LedgerTask[]): Map<string, AgentRecord> {
  const records = new Map<string, AgentRecord>();
  const live = new Map<string, string | undefined>();
  for (const { outcome, sessionId } of tasks) {
    const record = records.get(outcome.agentId) ?? { tasks: 0, files: [], trouble: false };
    record.tasks++;
    if (outcome.status !== 'done') record.trouble = true;
    if (!live.has(outcome.agentId)) live.set(outcome.agentId, currentSession(tasks, outcome.agentId));
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
  const shown = record.files.slice(0, SESSION_FILES).map((file) => relative(file, workspaceDir));
  const more = record.files.length - shown.length;
  const parts = [`${record.tasks} task${record.tasks === 1 ? '' : 's'} this run`];
  if (shown.length > 0) {
    parts.push(`previously saw ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
  }
  if (record.trouble) parts.push('one of them did not finish');
  return parts.join('; ');
}

export interface HandoffInput {
  query?: string;
  tasks: readonly LedgerTask[];
  /** Who is about to be briefed. Its own tasks are left out: its session remembers them. */
  agentId: string;
  /**
   * Whether the agent's own tasks go in too — for a session that is new and
   * remembers nothing, which is when "since your last task" has to mean
   * "since the run began".
   */
  includeOwn: boolean;
  workspaceDir: string;
  /**
   * What each agent is for, as the config has it. A handoff names the role the
   * first time an agent appears in it: "gemini changed the tests" is a fact
   * about a stranger until you know what gemini is for.
   */
  roleOf?: (agentId: string) => string;
  /**
   * How long the whole section may be, in characters. Entries are spent newest
   * first; the ones that do not fit become a count — except a task that did not
   * finish, which stays in on one line whatever the budget says. What went
   * wrong is the one thing a session must not be spared.
   */
  budgetChars?: number;
}

/** What a handoff may run to when the caller did not say: about 400 tokens. */
export const HANDOFF_BUDGET_CHARS = 1600;

/**
 * What the other agents did while this one was not looking, for the foot of
 * its brief: the files each changed, what it said it did, what it decided and
 * what it left open — in its own words rather than the planner's. Paths and
 * not contents — the agent can read a file, and reading it is cheaper and
 * truer than being told.
 */
export function renderHandoff(input: HandoffInput): string {
  const relevant = input.tasks.filter(({ outcome, resolved }) => {
    if (resolved) return false;
    if (!input.includeOwn && outcome.agentId === input.agentId) return false;
    return (
      outcome.changed.length > 0 ||
      outcome.report.summary !== '' ||
      outcome.report.open.length > 0 ||
      outcome.status !== 'done'
    );
  });
  if (relevant.length === 0) return '';

  // Rendered newest first against the budget, then put back in order. The
  // role goes on an agent's first mention in reading order, so it is settled
  // once the set of shown entries is known.
  const entries = relevant.map(({ outcome }) => ({ outcome, lines: renderEntry(outcome, input) }));
  const budget = input.budgetChars ?? HANDOFF_BUDGET_CHARS;
  const kept = new Set<number>();
  let spent = 0;
  const order = entries.map((entry, at) => ({ at, score: input.query
    ? [...entry.outcome.changed, ...entry.outcome.files].filter((file) => input.query!.includes(relative(file, input.workspaceDir))).length : 0 }))
    .sort((a, b) => b.score - a.score || b.at - a.at);
  for (const { at } of order) {
    const entry = entries[at]!;
    const cost = entry.lines.join('\n').length + 1;
    const troubled = entry.outcome.status !== 'done';
    if (spent + cost <= budget) {
      spent += cost;
      kept.add(at);
    } else if (troubled) {
      // On one line: the fact of the failure, not the account of it.
      entry.lines = [entry.lines[0]!, ...entry.outcome.report.open.map((line) => `  open: ${line}`)];
      kept.add(at);
    }
  }

  const lines = ['Since your last task:'];
  const dropped = entries.length - kept.size;
  if (dropped > 0) lines.push(`- …${dropped} earlier tasks not listed.`);
  const introduced = new Set<string>();
  for (let at = 0; at < entries.length; at++) {
    if (!kept.has(at)) continue;
    const entry = entries[at]!;
    const { agentId } = entry.outcome;
    const role = introduced.has(agentId) ? '' : input.roleOf?.(agentId) ?? '';
    introduced.add(agentId);
    const who = `${agentId}${role ? ` (${role})` : ''}`;
    lines.push(entry.lines[0]!.replace('{who}', who), ...entry.lines.slice(1));
  }
  return lines.join('\n');
}

function renderEntry(outcome: TaskOutcome, input: HandoffInput): string[] {
  const files = outcome.changed.map((file) => relative(file, input.workspaceDir));
  const did = files.length > 0 ? `changed ${files.join(', ')}` : 'changed nothing';
  const status = outcome.status === 'done' ? '' : ` — ${outcome.status}`;
  const lines = [`- {who}, task ${outcome.taskId}: ${did}${status}`];
  const { report } = outcome;
  if (report.outcome && report.outcome !== 'done') lines.push(`  outcome: ${report.outcome}`);
  if (report.summary) lines.push(`  did: ${oneLine(report.summary, HANDOFF_SUMMARY_CHARS)}`);
  for (const item of report.decided) lines.push(`  decided: ${item}`);
  for (const item of report.open) lines.push(`  open: ${item}`);
  if (report.verify) lines.push(`  verify: ${report.verify}`);
  return lines;
}
