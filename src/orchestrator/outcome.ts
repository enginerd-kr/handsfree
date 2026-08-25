import type { ParsedOutput, TaskStatus } from '../agents/types.js';
import type { RunResult } from '../agents/runner.js';

export function classifyOutcome(run: RunResult, parsed: ParsedOutput): TaskStatus {
  if (run.timedOut) return 'timeout';
  if (parsed.denials.length > 0) return 'blocked_by_permissions';
  if (run.exitCode !== 0 || parsed.isError) return 'error';
  return 'success';
}
