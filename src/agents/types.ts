import type { AgentName, Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';

export interface Invocation {
  command: string;
  args: string[];
}

/**
 * A finished CLI run, split by channel. Adapters parse `stdout` — the channel the
 * CLIs put their structured output on — and read `stderr` for diagnostics only.
 * Parsing the interleaved stream instead lets one stray warning line corrupt a
 * `JSON.parse` and turn a failed run into a silent "success".
 */
export interface AgentOutput {
  stdout: string;
  stderr: string;
}

export interface ParsedOutput {
  /** The agent's final message, best-effort extracted from CLI output. */
  finalMessage: string;
  /** True when the CLI reported an error state in its structured output. */
  isError: boolean;
  /**
   * Denials the CLI reported structurally (claude's `permission_denials`, codex's
   * error events). Authoritative: these alone mean the task was blocked.
   */
  denials: string[];
  /**
   * Denial phrases matched in free text. Weaker evidence — agents narrate denials
   * they routed around ("couldn't run the shell command, so I wrote the file
   * directly"), and that is a success, not a block. See `findDenialPhrases`.
   */
  denialHints: string[];
}

export interface AgentAdapter {
  name: AgentName;
  /** Build the minimum-scope argv. Must never include bypass flags. */
  buildInvocation(prompt: string, task: TaskPaths, runDir: string, config: Config): Invocation;
  parseOutput(out: AgentOutput, task: TaskPaths): ParsedOutput;
}

export type TaskStatus = 'success' | 'blocked_by_permissions' | 'error' | 'timeout' | 'cancelled';

export interface DelegationResult {
  status: TaskStatus;
  summary: string;
  exitCode: number | undefined;
}
