import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream, type ClientApp, type ClientConnection } from '@agentclientprotocol/sdk';
import { assertLaunchArgsAllowed, type AgentProfile, type EnvConfig } from '../config/schema.js';
import { debug, debugEnabled, describeProxyEnv } from '../debug.js';
import type { ConnectionTarget } from './connection.js';

export interface SpawnOptions {
  cwd: string;
  /** The config's top-level `env` block, applied to the child before the profile's `env`. */
  env?: EnvConfig;
  /** Diagnostics from the adapter. Never parsed — only surfaced. */
  onStderr?: (text: string) => void;
}

/**
 * The environment an agent actually starts with, layered so the most specific
 * intent wins: the parent environment, then the config's top-level `env`
 * block, then the profile's own `env` — in both blocks a `null` removes the
 * variable. This is the handsfree-owned replacement for wrapping the CLI in a
 * shell alias, which never applies to processes spawned directly.
 */
export function childEnv(
  profile: AgentProfile,
  shared: EnvConfig | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const layer of [shared ?? {}, profile.env]) {
    for (const [name, value] of Object.entries(layer)) {
      if (value === null) delete env[name];
      else env[name] = value;
    }
  }
  env['NO_COLOR'] = '1';
  return env;
}

/**
 * An ACP agent is an ordinary child process that happens to speak JSON-RPC on
 * its stdio. Nothing about the launch grants it privileges: the process starts
 * in its own default permission mode. Native tools use the adapter's own
 * permissions and sandbox.
 */
export function spawnTarget(profile: AgentProfile, options: SpawnOptions): ConnectionTarget {
  // Last gate before exec: a bypass flag must never reach an agent's argv.
  assertLaunchArgsAllowed(profile.args, `${profile.command} argv`, profile.command);

  const env = childEnv(profile, options.env);
  if (debugEnabled()) {
    debug('spawn', `${[profile.command, ...profile.args].join(' ')} (cwd ${options.cwd})`);
    const describe = (layer: EnvConfig) =>
      Object.entries(layer)
        .map(([name, value]) => `${name}=${value === null ? '<unset>' : 'set'}`)
        .join(' ');
    if (options.env && Object.keys(options.env).length > 0) {
      debug('spawn', `env from config: ${describe(options.env)}`);
    }
    if (Object.keys(profile.env).length > 0) {
      debug('spawn', `profile env overrides: ${describe(profile.env)}`);
    }
    debug('spawn', `child proxy env: ${describeProxyEnv(env)}`);
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
  let closing: Promise<void> | undefined;
  let resolveExited: () => void;
  const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
  const broken = new Promise<Error>((resolve) => {
    child.once('error', (err) => {
      settled = true;
      resolveExited();
      debug('spawn', `${profile.command} failed to start: ${err.message}`);
      resolve(new Error(`could not start ${profile.command}: ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      settled = true;
      resolveExited();
      debug('spawn', `${profile.command} exited (${signal ? `signal ${signal}` : `code ${code}`})`);
      resolve(
        new Error(
          `${profile.command} exited before the session started ` +
            `(${signal ? `signal ${signal}` : `code ${code}`})`,
        ),
      );
      // Sweep promptly if the wrapper dies mid-run, before its group ID
      // could be reused. A later close() joins this same cleanup.
      closing ??= close();
      void closing.catch((error: unknown) => debug('spawn', `cleanup failed: ${String(error)}`));
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
    close(): Promise<void> {
      return closing ??= close();
    },
  };

  async function close(): Promise<void> {
    // Descendants can keep inherited pipes open after the wrapper exits.
    const releasePipes = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    try {
      if (child.pid === undefined) return;
      // The end of stdin is how an adapter is told the host has gone, and
      // the one it can act on: it cancels its sessions and lets its own
      // children — a Claude Code process, say — leave in good order. A
      // signal to the group reaches those children at the same moment it
      // reaches the adapter, and what the adapter then logs is that every
      // session's teardown failed because the process it was tearing down
      // had already been killed. So EOF first, a moment to act on it, and
      // the signals only for an adapter that did not.
      if (!settled) child.stdin?.end();
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          grace = setTimeout(() => resolve(false), EOF_GRACE_MS);
        }),
      ]).finally(() => clearTimeout(grace));
      // A wrapper may have exited before close() was called. Its process
      // group still belongs to us, and its descendants also get a TERM grace.
      if (groupAlive(child)) {
        killGroup(child, 'SIGTERM');
        const deadline = Date.now() + 2_000;
        while (groupAlive(child) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (groupAlive(child)) killGroup(child, 'SIGKILL');
      }
      await exited;
    } finally {
      releasePipes();
    }
  }
}

/** How long an adapter has to leave on its own after its stdin ends, before it is signalled. */
const EOF_GRACE_MS = 1_000;

function groupAlive(child: ReturnType<typeof spawn>): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    return child.exitCode === null && child.signalCode === null;
  }
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
