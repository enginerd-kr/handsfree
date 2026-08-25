import type { AgentName, Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';

export interface Invocation {
  command: string;
  args: string[];
}

export interface ParsedOutput {
  /** The agent's final message, best-effort extracted from CLI output. */
  finalMessage: string;
  /** True when the CLI reported an error state in its structured output. */
  isError: boolean;
  /** Evidence of permission/approval denials found in the output. */
  denials: string[];
}

export interface AgentAdapter {
  name: AgentName;
  /** Build the minimum-scope argv. Must never include bypass flags. */
  buildInvocation(prompt: string, task: TaskPaths, runDir: string, config: Config): Invocation;
  parseOutput(raw: string, task: TaskPaths): ParsedOutput;
}

export type TaskStatus = 'success' | 'blocked_by_permissions' | 'error' | 'timeout';

export interface DelegationResult {
  status: TaskStatus;
  summary: string;
  exitCode: number | undefined;
}
