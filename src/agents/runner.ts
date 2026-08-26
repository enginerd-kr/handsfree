import { execa } from 'execa';
import { assertNoForbiddenArgs } from '../config/schema.js';
import type { Invocation } from './types.js';

export interface RunResult {
  exitCode: number | undefined;
  /** stdout only — the channel CLIs put their structured output on. */
  stdout: string;
  /** stderr only — diagnostics, never parsed as the CLI's structured result. */
  stderr: string;
  /** stdout+stderr interleaved, kept for the raw log and live streaming. */
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export async function runCli(inv: Invocation, opts: RunOptions): Promise<RunResult> {
  // Final gate: no invocation ever leaves this process with a bypass flag.
  assertNoForbiddenArgs(inv.args, `${inv.command} argv`);

  const subprocess = execa(inv.command, inv.args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    cancelSignal: opts.signal,
    // Headless CLIs must never sit waiting for an approval keypress.
    stdin: 'ignore',
    all: true,
    reject: false,
    env: { ...process.env, NO_COLOR: '1' },
  });

  if (opts.onChunk) {
    void (async () => {
      try {
        for await (const line of subprocess.iterable({ from: 'all', preserveNewlines: true })) {
          opts.onChunk?.(line);
        }
      } catch {
        // Stream ends when the process dies; errors are reflected in the result.
      }
    })();
  }

  const result = await subprocess;
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: result.all ?? '',
    timedOut: result.timedOut,
    aborted: opts.signal?.aborted === true,
  };
}
