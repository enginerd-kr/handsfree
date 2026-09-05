import path from 'node:path';
import type { StopReason } from '@agentclientprotocol/sdk';
import { agentText, changedFiles, touchedFiles, type TranscriptRecord } from '../workspace/transcript.js';
import { DEFAULT_REPORT_LIMITS, parseReport, type Report, type ReportLimits } from './report.js';
import type { TokenUsage } from './meter.js';

export type TaskStatus = 'done' | 'blocked' | 'incomplete' | 'refused' | 'cancelled' | 'error';

export interface TaskOutcome {
  taskId: number;
  agentId: string;
  task: string;
  status: TaskStatus;
  stopReason?: StopReason | 'unresponsive';
  usage?: TokenUsage;
  routingUsage?: TokenUsage;
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
 * Protocol termination and reported task outcome are distinct. A clean turn
 * reporting blocked/partial must not be treated as completed work. Without a
 * report, end_turn remains a legacy success signal; it is not verification.
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
      const rel = path.relative(options.workspaceDir, absolute);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      if (!changed.includes(absolute)) changed.push(absolute);
    }
  }

  return {
    taskId,
    agentId,
    task,
    status: stopReason === 'end_turn' && report.outcome === 'blocked' ? 'blocked'
      : stopReason === 'end_turn' && report.outcome === 'partial' ? 'incomplete' : statusOf(stopReason),
    stopReason,
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
  maxChars?: number;
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
  if (options.maxChars !== undefined) return renderCompactOutcome(outcome, workspaceDir, options.maxChars, options.relayMessage);
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
  // Changed apart from merely read: a reader that sees one list calls all of
  // it "modified", and a file that was only opened is not a change to report.
  const changed = outcome.changed.map((file) => relative(file, workspaceDir));
  const read = outcome.files
    .filter((file) => !outcome.changed.includes(file))
    .map((file) => relative(file, workspaceDir));
  if (changed.length > 0) parts.push(`changed ${changed.join(', ')}`);
  if (read.length > 0) parts.push(`read ${read.join(', ')}`);
  if (outcome.denials.length > 0) parts.push(`refused: ${outcome.denials.join('; ')}`);
  return parts.join(' — ');
}

export function relative(file: string, root: string): string {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : file;
}

/** Spend space on status and blockers before paths or optional prose. */
function renderCompactOutcome(outcome: TaskOutcome, root: string, max: number, relay = false): string {
  const lines = [`Task ${outcome.taskId} (${outcome.agentId}): ${outcome.status}`];
  if (max < lines[0]!.length + 40) throw new Error('Result budget is too small to preserve task status');
  const required = [...outcome.denials.map((line) => `refused: ${line}`), ...outcome.report.open.map((line) => `open: ${line}`)];
  if (outcome.report.summary) required.push(`summary: ${outcome.report.summary}`);
  for (const line of required) lines.push(line);
  const essential = lines.join('\n');
  // If even required fields do not fit, fail visibly instead of implying success.
  if (essential.length > max) {
    const head = lines[0]!;
    const marker = '\n[details omitted; retrieve task result]';
    return `${head}\n${required.join('\n').slice(0, Math.max(0, max - head.length - marker.length - 1))}${marker}`;
  }
  const optional = [
    ...(outcome.changed.length ? [`changed: ${outcome.changed.map((file) => relative(file, root)).join(', ')}`] : []),
    ...(relay && outcome.message ? [outcome.message] : []),
  ];
  for (const line of optional) {
    if (lines.join('\n').length + line.length + 1 <= max) lines.push(line);
    else if (lines.join('\n').length + 29 <= max) lines.push('[details in task result]');
  }
  return lines.join('\n');
}
