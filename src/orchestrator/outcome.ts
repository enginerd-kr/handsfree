import type { StopReason } from '@agentclientprotocol/sdk';
import { agentText, changedFiles, touchedFiles, type TranscriptRecord } from '../workspace/transcript.js';

export type TaskStatus = 'done' | 'incomplete' | 'refused' | 'cancelled' | 'error';

export interface TaskOutcome {
  taskId: number;
  agentId: string;
  task: string;
  status: TaskStatus;
  /** What the agent said at the end of the turn. */
  message: string;
  /** Absolute paths the agent reported touching, reads included. */
  files: string[];
  /** The subset it wrote, edited, moved or deleted — what is different now. */
  changed: string[];
  /** Everything handsfree refused during this task, in order. */
  denials: string[];
  durationMs: number;
}

/**
 * The status comes from the protocol, not from reading the agent's prose. A turn
 * that ended with `end_turn` finished; one that was refused says so. Denials are
 * reported alongside rather than folded in, because an agent that was refused a
 * shell and wrote the file instead did finish the job — and we know it did,
 * since every refusal in the list is one we issued ourselves.
 */
export function summarise(
  taskId: number,
  agentId: string,
  task: string,
  stopReason: StopReason | 'unresponsive',
  records: readonly TranscriptRecord[],
  durationMs: number,
): TaskOutcome {
  const denials: string[] = [];
  for (const record of records) {
    if (record.type === 'decision' && record.entry.verdict === 'deny') {
      denials.push(`${record.entry.summary}${record.entry.reason ? ` (${record.entry.reason})` : ''}`);
    }
  }

  return {
    taskId,
    agentId,
    task,
    status: statusOf(stopReason),
    message: agentText(records),
    files: touchedFiles(records),
    changed: changedFiles(records),
    denials,
    durationMs,
  };
}

function statusOf(stopReason: StopReason | 'unresponsive'): TaskStatus {
  switch (stopReason) {
    case 'end_turn':
      return 'done';
    case 'refusal':
      return 'refused';
    case 'cancelled':
      return 'cancelled';
    case 'max_tokens':
    case 'max_turn_requests':
      return 'incomplete';
    default:
      return 'error';
  }
}

export function renderOutcome(outcome: TaskOutcome, workspaceDir: string): string {
  const head = renderOutcomeHead(outcome, workspaceDir);
  return outcome.message ? `${head}\n${outcome.message}` : head;
}

/**
 * The one line that says what became of a task: status, time, files, refusals.
 * It is what the planner keeps once the agent's words have been relayed — the
 * words are the bulk of a result, and once passed on they are only bulk.
 */
export function renderOutcomeHead(outcome: TaskOutcome, workspaceDir: string): string {
  const parts = [`Task ${outcome.taskId} (${outcome.agentId}): ${outcome.status}`];
  parts.push(`after ${Math.round(outcome.durationMs / 1000)}s`);
  const files = outcome.files.map((file) => relative(file, workspaceDir));
  if (files.length > 0) parts.push(`touched ${files.join(', ')}`);
  if (outcome.denials.length > 0) parts.push(`refused: ${outcome.denials.join('; ')}`);
  return parts.join(' — ');
}

export function relative(file: string, root: string): string {
  return file.startsWith(root) ? file.slice(root.length).replace(/^\//, '') : file;
}
