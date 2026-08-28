import { spawn, type ChildProcess } from 'node:child_process';
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
import { render } from '../policy/exec.js';
import type { HostContext } from './context.js';

/**
 * Environment names that let a caller change what a command *is* rather than
 * what it does. They are dropped whatever the agent asks for, because a command
 * cleared by the allowlist should be the command that actually runs.
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

interface Terminal {
  id: string;
  child: ChildProcess;
  argv: string[];
  chunks: Buffer[];
  bytes: number;
  limit: number;
  truncated: boolean;
  exit: Promise<{ exitCode: number | null; signal: string | null }>;
  status: { exitCode: number | null; signal: string | null } | undefined;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Gate C. Declaring the terminal capability means every command an agent runs is
 * a command handsfree started: same allowlist, same working directory, same
 * output ceiling, whichever agent asked. The alternative is not "no commands" —
 * it is commands we cannot see, run by each CLI's own sandbox.
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
    if (!jailed.ok) throw RequestError.invalidParams(jailed.reason);

    const execPolicy = this.host.config.policy.exec;
    const limit = params.outputByteLimit ?? execPolicy.outputByteLimit;
    const id = `term-${++this.counter}`;
    const child = spawn(params.command, args, {
      cwd: jailed.real,
      env: buildEnv(execPolicy.env, params.env ?? []),
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
      status: undefined,
      timer: undefined,
      exit: new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }));
        child.once('error', () => resolve({ exitCode: null, signal: 'ENOENT' }));
      }),
    };

    child.stdout?.on('data', (chunk: Buffer) => append(terminal, chunk));
    child.stderr?.on('data', (chunk: Buffer) => append(terminal, chunk));
    terminal.exit.then((status) => {
      terminal.status = status;
      if (terminal.timer) clearTimeout(terminal.timer);
    });
    terminal.timer = setTimeout(() => {
      if (!terminal.status) killGroup(terminal, 'SIGKILL');
    }, execPolicy.timeoutMs);

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
}

function append(terminal: Terminal, chunk: Buffer): void {
  terminal.chunks.push(chunk);
  terminal.bytes += chunk.byteLength;
  while (terminal.bytes > terminal.limit && terminal.chunks.length > 1) {
    const dropped = terminal.chunks.shift()!;
    terminal.bytes -= dropped.byteLength;
    terminal.truncated = true;
  }
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
