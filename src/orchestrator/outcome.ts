import path from 'node:path';
import type { StopReason } from '@agentclientprotocol/sdk';
import { agentText, changedFiles, touchedFiles, type TranscriptRecord } from '../workspace/transcript.js';
import { DEFAULT_REPORT_LIMITS, parseReport, type Report, type ReportLimits } from './report.js';

export type TaskStatus = 'done' | 'incomplete' | 'refused' | 'cancelled' | 'error';

export interface TaskOutcome {
  taskId: number;
  agentId: string;
  task: string;
  status: TaskStatus;
  /** What the agent said at the end of the turn, whole. */
  message: string;
  /** The agent's account of itself, in the shape it was asked for — or a fallback. */
  report: Report;
  /** Absolute paths the agent reported touching, reads included. */
  files: string[];
  /**
   * The subset it wrote, edited, moved or deleted — what is different now. The
   * record's own account first, and then what the report named that the record
   * missed: a file changed through a shell command leaves no tool call behind.
   */
  changed: string[];
  /** Everything handsfree refused during this task, in order. */
  denials: string[];
  durationMs: number;
  /** How long the brief that started it was, for the usage record. Absent when none went out. */
  briefChars?: number;
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
  options: { workspaceDir?: string; report?: ReportLimits } = {},
): TaskOutcome {
  const denials: string[] = [];
  for (const record of records) {
    if (record.type === 'decision' && record.entry.verdict === 'deny') {
      denials.push(`${record.entry.summary}${record.entry.reason ? ` (${record.entry.reason})` : ''}`);
    }
  }

  const message = agentText(records);
  const report = parseReport(message, options.report ?? DEFAULT_REPORT_LIMITS);
  const changed = changedFiles(records);
  // Only paths the report names that resolve inside the workspace: a report
  // is the agent's word, and a path outside the jail is a path it could not
  // have changed through handsfree.
  if (options.workspaceDir) {
    for (const named of report.changed) {
      const absolute = path.resolve(options.workspaceDir, named);
      if (!absolute.startsWith(options.workspaceDir)) continue;
      if (!changed.includes(absolute)) changed.push(absolute);
    }
  }

  return {
    taskId,
    agentId,
    task,
    status: statusOf(stopReason),
    message,
    report,
    files: touchedFiles(records),
    changed,
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

export interface RenderOptions {
  /**
   * Whether the agent's whole message follows the head, the way it used to.
   * Off, what follows is the report's summary and open items — the user has
   * seen the rest on screen, as it streamed.
   */
  relayMessage?: boolean;
}

/**
 * What the planner is handed when a task ends. The head is the facts the
 * record established; under it, what the agent said it did and what it left
 * open — the two fields a routing decision can turn on. Decisions and the
 * verify line are for the next agent, not the planner, and go out in the
 * handoff instead.
 */
export function renderOutcome(
  outcome: TaskOutcome,
  workspaceDir: string,
  options: RenderOptions = {},
): string {
  const lines = [renderOutcomeHead(outcome, workspaceDir)];
  if (options.relayMessage) {
    if (outcome.message) lines.push(outcome.message);
    return lines.join('\n');
  }
  const { report } = outcome;
  if (report.outcome && report.outcome !== 'done') lines.push(`agent says: ${report.outcome}`);
  if (report.summary) lines.push(`summary: ${report.summary}`);
  for (const item of report.open) lines.push(`open: ${item}`);
  return lines.join('\n');
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
