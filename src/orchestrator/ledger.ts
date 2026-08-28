import type { TranscriptRecord } from '../workspace/transcript.js';
import { relative, renderOutcomeHead, summarise, type TaskOutcome } from './outcome.js';

/** A finished task as the transcript tells it, with where in the record it ended. */
export interface LedgerTask {
  outcome: TaskOutcome;
  /** The seq of the task's `stop` record: what "since" is measured against. */
  seq: number;
}

/** How many tasks the run state spells out before older ones become a count. */
const LEDGER_TASKS = 24;
/** How many handoff entries a brief carries before older ones become a count. */
const HANDOFF_ENTRIES = 10;
/** How much of an agent's closing account the next agent is handed. */
const ACCOUNT_CHARS = 300;

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

/**
 * Every task that has finished since `after`, oldest first, rebuilt from the
 * record the same way the planner was told about it the first time. Nothing
 * here is remembered in a second place: a restart that replays the file, or a
 * test that fabricates one, sees the same ledger the live run did.
 */
export function tasksSince(records: readonly TranscriptRecord[], after: number): LedgerTask[] {
  const open = new Map<number, { at: number; startedAt: number }>();
  const tasks: LedgerTask[] = [];
  for (let at = 0; at < records.length; at++) {
    const record = records[at]!;
    if (record.type === 'delegation') {
      open.set(record.taskId, { at, startedAt: record.at });
      continue;
    }
    if (record.type !== 'stop') continue;
    const start = open.get(record.taskId);
    open.delete(record.taskId);
    if (!start || record.seq <= after) continue;
    const slice = records.slice(start.at, at + 1);
    const delegation = slice[0];
    if (delegation?.type !== 'delegation') continue;
    tasks.push({
      seq: record.seq,
      outcome: summarise(
        record.taskId,
        record.agentId,
        delegation.task,
        record.stopReason,
        slice,
        record.at - start.startedAt,
      ),
    });
  }
  return tasks;
}

/**
 * What the planner is told about the run so far, in place of the raw exchanges
 * it used to keep: a line per task and the files that are different for it.
 * Built from the record by code, so it costs nothing to produce and never
 * drifts from what happened — a model summarising its own history would do
 * both.
 */
export function renderRunState(tasks: readonly LedgerTask[], workspaceDir: string): string {
  if (tasks.length === 0) return '';
  const shown = tasks.slice(-LEDGER_TASKS);
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
  }
  const changed = new Set<string>();
  for (const { outcome } of tasks) {
    for (const file of outcome.changed) changed.add(relative(file, workspaceDir));
  }
  if (changed.size > 0) lines.push(`Files changed this run: ${[...changed].join(', ')}`);
  return lines.join('\n');
}

export interface HandoffInput {
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
}

/**
 * What the other agents did while this one was not looking, for the foot of
 * its brief: the files each changed and the account each gave of itself, in
 * its own words rather than the planner's. Paths and not contents — the agent
 * can read a file, and reading it is cheaper and truer than being told.
 */
export function renderHandoff(input: HandoffInput): string {
  const relevant = input.tasks.filter(({ outcome }) => {
    if (!input.includeOwn && outcome.agentId === input.agentId) return false;
    return outcome.changed.length > 0 || outcome.message !== '' || outcome.status !== 'done';
  });
  if (relevant.length === 0) return '';

  const shown = relevant.slice(-HANDOFF_ENTRIES);
  const lines = ['Since your last task:'];
  if (relevant.length > shown.length) lines.push(`- …${relevant.length - shown.length} earlier tasks not listed.`);
  for (const { outcome } of shown) {
    const files = outcome.changed.map((file) => relative(file, input.workspaceDir));
    const did = files.length > 0 ? `changed ${files.join(', ')}` : 'changed nothing';
    const status = outcome.status === 'done' ? '' : ` — ${outcome.status}`;
    lines.push(`- ${outcome.agentId} (task ${outcome.taskId}) ${did}${status}`);
    if (outcome.message !== '') lines.push(`  "${oneLine(outcome.message, ACCOUNT_CHARS)}"`);
  }
  return lines.join('\n');
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
