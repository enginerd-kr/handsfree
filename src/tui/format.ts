import type { TaskStatus } from '../agents/types.js';

export { formatDuration } from '../util/duration.js';

export const STATUS_ICON: Record<TaskStatus | 'running', string> = {
  running: '◐',
  success: '✓',
  error: '✗',
  timeout: '⏱',
  cancelled: '⊗',
  blocked_by_permissions: '⊘',
};

export const STATUS_COLOR: Record<TaskStatus | 'running', string> = {
  running: 'yellow',
  success: 'green',
  error: 'red',
  timeout: 'magenta',
  cancelled: 'gray',
  blocked_by_permissions: 'yellow',
};

/** How an outcome reads on the `⎿` line under a delegation. */
export const STATUS_LABEL: Record<TaskStatus | 'running', string> = {
  running: 'Running',
  success: 'Done',
  error: 'Failed',
  timeout: 'Timed out',
  cancelled: 'Interrupted by user',
  blocked_by_permissions: 'Blocked by permissions',
};

/** Collapse a task prompt to a single line that fits inside `agent(…)`. */
export function summarize(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
