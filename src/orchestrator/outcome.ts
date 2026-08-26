import type { ParsedOutput, TaskStatus } from '../agents/types.js';
import type { RunResult } from '../agents/runner.js';

export function classifyOutcome(run: RunResult, parsed: ParsedOutput): TaskStatus {
  if (run.aborted) return 'cancelled';
  if (run.timedOut) return 'timeout';
  // Structural denials are authoritative regardless of exit code.
  if (parsed.denials.length > 0) return 'blocked_by_permissions';
  if (parsed.denialHints.length > 0) return 'blocked_by_permissions';
  if (run.exitCode !== 0 || parsed.isError) return 'error';
  return 'success';
}
