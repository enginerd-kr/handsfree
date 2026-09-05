import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  RequestError,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type ReleaseTerminalRequest,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';
import { debug } from '../debug.js';
import { render } from '../policy/exec.js';
import type { HostContext } from './context.js';

/**
 * Environment names that let a caller change what a command *is* rather than
 * what it does. They are dropped whatever the agent asks for, because a command
 * approved by the user should be the command that actually runs.
 */
const UNSAFE_ENV = [
  /^LD_/,
  /^DYLD_/,
  /^NODE_OPTIONS$/,
  /^BASH_ENV$/,
  /^ENV$/,
  /^PERL5OPT$/,
  /^PYTHONSTARTUP$/,
  /^GIT_SSH_COMMAND$/,
  /^PATH$/,
];

/**
 * How much of what was cut from a terminal's output is kept aside for the
 * spill file. Bounded, because a command that never stops printing must not
 * be able to fill memory through the very mechanism meant to contain it.
 */
const SPILL_KEEP_BYTES = 4 * 1024 * 1024;

interface Terminal {
  id: string;
  child: ChildProcess;
  argv: string[];
  chunks: Buffer[];
  bytes: number;
  limit: number;
  truncated: boolean;
  /** What fell off the front, oldest first, up to SPILL_KEEP_BYTES. */
  overflow: Buffer[];
  overflowBytes: number;
  /** How much was cut altogether, kept or not. */
  cutBytes: number;
  exit: Promise<{ exitCode: number | null; signal: string | null }>;
  status: { exitCode: number | null; signal: string | null } | undefined;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Host terminals share the session approval flow, process lifecycle management,
 * and resource settings. Adapters may also provide their own native terminals.
 */
export class TerminalRegistry {
  private readonly terminals = new Map<string, Terminal>();
  private counter = 0;

  constructor(private readonly host: HostContext) {}

  handlers() {
    return {
      create: (params: CreateTerminalRequest, signal?: AbortSignal) => this.create(params, signal),
      output: (params: TerminalOutputRequest) => this.output(params),
      waitForExit: (params: WaitForTerminalExitRequest) => this.waitForExit(params),
      kill: (params: KillTerminalRequest) => this.kill(params),
      release: (params: ReleaseTerminalRequest) => this.release(params),
    };
  }

  /** Kills anything still running. Called when the connection goes away. */
  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) this.dispose(id);
  }

  private async create(
    params: CreateTerminalRequest,
    signal?: AbortSignal,
  ): Promise<CreateTerminalResponse> {
    const cwd = params.cwd ?? this.host.workspace.dir;
    const args = params.args ?? [];
    const decision = await this.host.policy.resolve(
      {
        kind: 'exec',
        agentId: this.host.agentId,
        sessionId: params.sessionId,
        command: params.command,
        args,
        cwd,
      },
      { ...(signal ? { signal } : {}) },
    );
    if (decision.verdict === 'deny') {
      throw new RequestError(
        -32000,
        `handsfree denied "${render([params.command, ...args])}"` +
          (decision.reason ? `: ${decision.reason}` : ''),
      );
    }

    const jailed = this.host.jail.check(cwd);

    const terminalConfig = this.host.config.execution.terminal;
    const limit = params.outputByteLimit ?? terminalConfig.outputByteLimit;
    const id = `term-${++this.counter}`;
    const child = spawn(params.command, args, {
      cwd: jailed.ok ? jailed.real : path.resolve(cwd),
      env: buildEnv(terminalConfig.env, params.env ?? []),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a kill reaches the whole tree rather than
      // leaving orphans behind holding the workspace open.
      detached: true,
    });

    const terminal: Terminal = {
      id,
      child,
      argv: [params.command, ...args],
      chunks: [],
      bytes: 0,
      limit: Math.max(limit, 1024),
      truncated: false,
      overflow: [],
      overflowBytes: 0,
      cutBytes: 0,
      status: undefined,
      timer: undefined,
      exit: new Promise((resolve) => {
        // `close`, not `exit`: the process can be gone while its last bytes
        // are still in the pipe, and a caller that waited for the exit and
        // then asked for the output would sometimes be handed nothing.
        child.once('close', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }));
        child.once('error', () => resolve({ exitCode: null, signal: 'ENOENT' }));
      }),
    };

    child.stdout?.on('data', (chunk: Buffer) => append(terminal, chunk));
    child.stderr?.on('data', (chunk: Buffer) => append(terminal, chunk));
    terminal.exit.then((status) => {
      terminal.status = status;
      if (terminal.timer) clearTimeout(terminal.timer);
      if (terminal.truncated) this.spill(terminal);
    });
    terminal.timer = setTimeout(() => {
      if (!terminal.status) killGroup(terminal, 'SIGKILL');
    }, terminalConfig.timeoutMs);

    this.terminals.set(id, terminal);
    this.host.transcript.append({
      type: 'note',
      level: 'info',
      text: `running ${render(terminal.argv)}`,
    });
    return { terminalId: id };
  }

  private async output(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.get(params.terminalId);
    return {
      output: text(terminal),
      truncated: terminal.truncated,
      exitStatus: terminal.status ?? null,
    };
  }

  private async waitForExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.get(params.terminalId);
    const status = terminal.status ?? (await terminal.exit);
    return { exitCode: status.exitCode, signal: status.signal };
  }

  private async kill(params: KillTerminalRequest): Promise<Record<string, never>> {
    killGroup(this.get(params.terminalId), 'SIGTERM');
    return {};
  }

  private async release(params: ReleaseTerminalRequest): Promise<Record<string, never>> {
    this.dispose(params.terminalId);
    return {};
  }

  private dispose(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    killGroup(terminal, 'SIGKILL');
    if (terminal.timer) clearTimeout(terminal.timer);
    this.terminals.delete(id);
  }

  private get(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw RequestError.invalidParams(`unknown terminal ${id}`);
    return terminal;
  }

  /**
   * The output whole — or as much of it as was kept — written under the run
   * directory, beside the transcript and outside the jail: for the person
   * reading the run, since the agent was handed the end of it and that is
   * where a failing command says why. The note names the file so a `/cost`
   * reader or a debugging one can find it; the agent is not told, and cannot
   * read it from where it stands.
   */
  private spill(terminal: Terminal): void {
    const dir = path.join(this.host.workspace.runDir, 'spill');
    const file = path.join(dir, `${terminal.id}.txt`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const lost = terminal.cutBytes - terminal.overflowBytes;
      const head = lost > 0 ? [Buffer.from(`[first ${lost} bytes not kept]\n`)] : [];
      fs.writeFileSync(file, Buffer.concat([...head, ...terminal.overflow, ...terminal.chunks]));
    } catch (err) {
      debug('terminal', `could not write ${file}: ${(err as Error).message}`);
      return;
    }
    this.host.transcript.append({
      type: 'note',
      level: 'info',
      text:
        `${render(terminal.argv)} printed ${size(terminal.cutBytes + terminal.bytes)}; ` +
        `the agent got the last ${size(terminal.limit)}, the whole output is at ${file}`,
    });
  }
}

function append(terminal: Terminal, chunk: Buffer): void {
  terminal.chunks.push(chunk);
  terminal.bytes += chunk.byteLength;
  while (terminal.bytes > terminal.limit) {
    // Whole chunks go first; a single chunk over the limit on its own — one
    // write of a whole file — is split, and its front goes the same way.
    let dropped: Buffer;
    if (terminal.chunks.length > 1) {
      dropped = terminal.chunks.shift()!;
    } else {
      const only = terminal.chunks[0]!;
      const excess = terminal.bytes - terminal.limit;
      dropped = only.subarray(0, excess);
      terminal.chunks[0] = only.subarray(excess);
    }
    terminal.bytes -= dropped.byteLength;
    terminal.truncated = true;
    terminal.cutBytes += dropped.byteLength;
    if (terminal.overflowBytes + dropped.byteLength <= SPILL_KEEP_BYTES) {
      terminal.overflow.push(dropped);
      terminal.overflowBytes += dropped.byteLength;
    }
  }
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function text(terminal: Terminal): string {
  const joined = Buffer.concat(terminal.chunks).toString('utf8');
  return terminal.truncated ? joined.slice(joined.indexOf('\n') + 1) : joined;
}

function killGroup(terminal: Terminal, signal: NodeJS.Signals): void {
  if (terminal.status || terminal.child.pid === undefined) return;
  try {
    process.kill(-terminal.child.pid, signal);
  } catch {
    try {
      terminal.child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export function buildEnv(
  forward: string[],
  requested: { name: string; value: string }[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of forward) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const { name, value } of requested) {
    if (UNSAFE_ENV.some((pattern) => pattern.test(name))) continue;
    env[name] = value;
  }
  return env;
}
