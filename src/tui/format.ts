import type { TaskStatus } from '../agents/types.js';

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const STATUS_ICON: Record<TaskStatus | 'running', string> = {
  running: '◐',
  success: '✓',
  error: '✗',
  timeout: '⏱',
  blocked_by_permissions: '⊘',
};

export const STATUS_COLOR: Record<TaskStatus | 'running', string> = {
  running: 'yellow',
  success: 'green',
  error: 'red',
  timeout: 'magenta',
  blocked_by_permissions: 'yellow',
};
