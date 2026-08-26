import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream, type ClientApp, type ClientConnection } from '@agentclientprotocol/sdk';
import { assertLaunchArgsAllowed, type AgentProfile } from '../config/schema.js';
import type { ConnectionTarget } from './connection.js';

export interface SpawnOptions {
  cwd: string;
  /** Diagnostics from the adapter. Never parsed — only surfaced. */
  onStderr?: (text: string) => void;
}

/**
 * An ACP agent is an ordinary child process that happens to speak JSON-RPC on
 * its stdio. Nothing about the launch grants it privileges: the process starts
 * in its own default permission mode and everything it wants comes back to us
 * as a request.
 */
export function spawnTarget(profile: AgentProfile, options: SpawnOptions): ConnectionTarget {
  // Last gate before exec: a bypass flag must never reach an agent's argv.
  assertLaunchArgsAllowed(profile.args, `${profile.command} argv`, profile.command);

  const child = spawn(profile.command, profile.args, {
    cwd: options.cwd,
    env: { ...process.env, ...profile.env, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Adapters explain themselves on stderr and then fail on stdout with a bare
  // "Internal error". Keeping the tail of it is the difference between a
  // diagnosable failure and a shrug.
  let recent = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => {
    recent = `${recent}${text}`.slice(-4000);
    options.onStderr?.(text);
  });

  let settled = false;
  const broken = new Promise<Error>((resolve) => {
    child.once('error', (err) => {
      settled = true;
      resolve(new Error(`could not start ${profile.command}: ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      settled = true;
      resolve(
        new Error(
          `${profile.command} exited before the session started ` +
            `(${signal ? `signal ${signal}` : `code ${code}`})`,
        ),
      );
    });
  });

  return {
    description: [profile.command, ...profile.args].join(' '),
    broken,
    diagnostics: () => recent.trim(),
    connect(app: ClientApp): ClientConnection {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      );
      return app.connect(stream);
    },
    async close(): Promise<void> {
      if (settled || child.pid === undefined) return;
      child.kill('SIGTERM');
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      await exited.finally(() => clearTimeout(timer));
    },
  };
}

/**
 * Alternative argv for adapters that have renamed a flag. Gemini's ACP switch
 * moved from `--experimental-acp` to `--acp`, and which one a given install
 * understands is not knowable without trying.
 */
export function fallbackArgs(args: string[]): string[] | undefined {
  if (args.includes('--experimental-acp')) {
    return args.map((arg) => (arg === '--experimental-acp' ? '--acp' : arg));
  }
  if (args.includes('--acp')) {
    return args.map((arg) => (arg === '--acp' ? '--experimental-acp' : arg));
  }
  return undefined;
}
