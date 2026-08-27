import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream, type ClientApp, type ClientConnection } from '@agentclientprotocol/sdk';
import { assertLaunchArgsAllowed, type AgentProfile } from '../config/schema.js';
import { debug, debugEnabled, describeProxyEnv } from '../debug.js';
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

  const env = { ...process.env, ...profile.env, NO_COLOR: '1' };
  if (debugEnabled()) {
    debug('spawn', `${[profile.command, ...profile.args].join(' ')} (cwd ${options.cwd})`);
    debug('spawn', `child proxy env: ${describeProxyEnv(env)}`);
    const overrides = Object.keys(profile.env);
    if (overrides.length > 0) debug('spawn', `profile env overrides: ${overrides.join(', ')}`);
  }

  // Its own process group: adapters hide behind wrappers — npx execs its
  // package, gemini relaunches itself — so the process that speaks ACP is a
  // grandchild that a plain kill to the child never reaches.
  const child = spawn(profile.command, profile.args, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.once('spawn', () => debug('spawn', `${profile.command} started, pid ${child.pid}`));

  // Adapters explain themselves on stderr and then fail on stdout with a bare
  // "Internal error". Keeping the tail of it is the difference between a
  // diagnosable failure and a shrug.
  let recent = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => {
    recent = `${recent}${text}`.slice(-4000);
    if (text.trim() !== '') debug(`stderr ${profile.command}`, text.trimEnd());
    options.onStderr?.(text);
  });

  let settled = false;
  const broken = new Promise<Error>((resolve) => {
    child.once('error', (err) => {
      settled = true;
      debug('spawn', `${profile.command} failed to start: ${err.message}`);
      resolve(new Error(`could not start ${profile.command}: ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      settled = true;
      debug('spawn', `${profile.command} exited (${signal ? `signal ${signal}` : `code ${code}`})`);
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
      // Whatever the tree below does, our ends of the stdio pipes close: a
      // grandchild that outlives the child would otherwise keep them — and the
      // event loop, and so the whole process — open for as long as it liked.
      const releasePipes = () => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      if (settled || child.pid === undefined) {
        releasePipes();
        return;
      }
      killGroup(child, 'SIGTERM');
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 2_000);
      await exited.finally(() => clearTimeout(timer));
      // The child's exit says nothing about the rest of its group; sweep it
      // while the group id is still fresh rather than leave orphans behind.
      killGroup(child, 'SIGKILL');
      releasePipes();
    },
  };
}

/** Signals the whole adapter tree, falling back to the child alone. */
function killGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
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
