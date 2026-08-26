import type { AgentName } from '../config/schema.js';
import type { TaskStatus } from '../agents/types.js';
import { formatDuration } from '../util/duration.js';

/** What one delegation did, recorded so the turn can be summarised without the LLM. */
export interface TurnTask {
  id: number;
  agent: AgentName;
  task: string;
  status: TaskStatus;
  summary: string;
  durationMs: number;
  /** Path to result.md, relative to the run dir. */
  resultPath: string;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  success: 'succeeded',
  error: 'failed',
  timeout: 'timed out',
  cancelled: 'was cancelled',
  blocked_by_permissions: 'was blocked by permissions',
};

function firstLine(text: string, max: number): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The summary of last resort, composed from recorded outcomes alone. handsfree
 * runs on a small local model that may be slow, wrong or unreachable, so the
 * user's report must not depend on it — this is what gets shown when asking the
 * model for prose fails or returns something unusable.
 */
export function renderTurnLedger(tasks: TurnTask[], notes: string[]): string {
  const ok = tasks.filter((t) => t.status === 'success').length;
  const plural = tasks.length === 1 ? '' : 's';
  const lines: string[] = [
    `${tasks.length} task${plural} ran — ${ok} succeeded, ${tasks.length - ok} did not.`,
  ];
  for (const t of tasks) {
    lines.push(
      `  ${t.agent} #${t.id} ${STATUS_LABEL[t.status]} in ${formatDuration(t.durationMs)} — ${firstLine(t.task, 100)}`,
    );
    const detail = firstLine(t.summary, 160);
    if (detail) lines.push(`      ${detail}`);
    lines.push(`      full result: ${t.resultPath}`);
  }
  for (const note of notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

/** The task ledger the summariser model is asked to turn into prose. */
export function renderTurnFacts(tasks: TurnTask[], notes: string[]): string {
  const blocks = tasks.map((t) =>
    [
      `Task ${t.id} (${t.agent})`,
      `  requested: ${t.task}`,
      `  status: ${t.status}`,
      `  took: ${formatDuration(t.durationMs)}`,
      `  agent reported: ${t.summary.trim() || '(nothing)'}`,
    ].join('\n'),
  );
  if (notes.length > 0) blocks.push(`Notes:\n${notes.map((n) => `  - ${n}`).join('\n')}`);
  return blocks.join('\n\n');
}
