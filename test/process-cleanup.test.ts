import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentProfileSchema, ConfigSchema } from '../src/config/schema.js';
import { spawnTarget } from '../src/host/launch.js';
import { createRuntime } from '../src/runtime.js';

const fixture = fileURLToPath(new URL('./fixtures/acp-process.cjs', import.meta.url));
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const cli = fileURLToPath(new URL('./fixtures/cli.cjs', import.meta.url));
const loader = import.meta.resolve('tsx');
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

interface Record { event: string; pid: number; mode: string }
function setup(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-process-'));
  const file = path.join(root, 'processes.jsonl');
  const records = (): Record[] => fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  cleanup.push(() => {
    // Only PIDs recorded by this fixture; never inspect or signal real agents.
    for (const pid of new Set(records().map((record) => record.pid))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const profile = AgentProfileSchema.parse({ command: process.execPath, args: [fixture, file, mode] });
  return { root, file, records, profile };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ready(records: () => Record[], diagnostics: () => string = () => ''): Promise<void> {
  try {
    await expect.poll(() => records().filter((record) => record.event === 'ready').length, { timeout: 5_000 }).toBe(2);
  } catch (error) {
    throw new Error(`Fixture did not start: ${diagnostics()}`, { cause: error });
  }
}

async function gone(records: () => Record[]): Promise<void> {
  await expect.poll(() => records().filter((record) => record.event === 'ready').some((record) => alive(record.pid)),
    { timeout: 5_000 }).toBe(false);
}

describe.skipIf(process.platform === 'win32')('ACP process cleanup', () => {
  it.each(['early-exit', 'eof', 'stubborn'])('reaps descendants when the wrapper leaves via %s', async (mode) => {
    const { root, profile, records } = setup(mode);
    const target = spawnTarget(profile, { cwd: root });
    cleanup.push(() => target.close());
    await ready(records);
    if (mode === 'early-exit') await target.broken;

    // Unexpected wrapper exits are cleaned even before the run is closed.
    if (mode === 'early-exit') await gone(records);

    const closing = target.close();
    expect(target.close()).toBe(closing);
    await closing;
    await gone(records);
    expect(records().some((record) => record.event === 'term' && record.mode.endsWith('worker'))).toBe(true);
    expect(records().some((record) => record.event === 'stopped')).toBe(mode !== 'stubborn');
    await target.close();
  });

  it('closes an established worker and planner together after a normal turn', async () => {
    const { root, profile, records } = setup('respond');
    const config = ConfigSchema.parse({ workspaceRoot: path.join(root, 'runs'), agents: { fixture: profile },
      orchestration: { provider: 'acp', acp: { agent: 'fixture' } } });
    const runtime = createRuntime({ config, cwd: root });
    cleanup.push(() => runtime.close());
    await runtime.pool.session('fixture');
    await runtime.conversation.send('hello');
    expect(runtime.transcript.all().some((record) => record.type === 'assistant' && record.text === 'Hello.')).toBe(true);
    await expect.poll(() => records().filter((record) => record.event === 'ready').length).toBe(4);

    await runtime.close();
    await gone(records);
    expect(records().filter((record) => record.event === 'stopped')).toHaveLength(2);
  });

  it('can repeatedly close a process that failed to spawn', async () => {
    const { root, profile } = setup('missing');
    const target = spawnTarget({ ...profile, command: path.join(root, 'missing-command') }, { cwd: root });
    cleanup.push(() => target.close());
    expect((await target.broken)?.message).toContain('could not start');
    await Promise.all([target.close(), target.close()]);
  });

  it.each(['pool', 'planner'])('closes a stalled %s handshake without waiting for its timeout or retrying', async (owner) => {
    const { root, profile, records } = setup('stall');
    // A fallback flag catches accidental relaunches during shutdown.
    profile.args.push('--acp');
    const config = ConfigSchema.parse({ workspaceRoot: path.join(root, 'runs'), agents: { fixture: profile },
      orchestration: { provider: 'acp', acp: { agent: 'fixture' } },
      limits: { handshakeTimeoutMs: 60_000 } });
    const runtime = createRuntime({ config, cwd: root });
    cleanup.push(() => runtime.close());
    const opening = owner === 'pool'
      ? runtime.pool.session('fixture').catch((error: unknown) => error)
      : runtime.conversation.send('hello').catch((error: unknown) => error);
    await ready(records);
    await expect.poll(() => records().some((record) => record.event === 'initialize')).toBe(true);

    const started = Date.now();
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await closing;
    await opening;
    expect(Date.now() - started).toBeLessThan(5_000);
    await gone(records);
    expect(records().filter((record) => record.event === 'ready')).toHaveLength(2);
    expect(runtime.pool.isOpen('fixture')).toBe(false);
    await expect(runtime.pool.connection('fixture')).rejects.toThrow('closed');
  });

  it.each([
    ['SIGTERM', 'run', 143], ['SIGHUP', 'run', 129], ['SIGTERM', 'doctor', 143],
    ['SIGTERM', 'tui', 143], ['SIGHUP', 'tui', 129],
    ['SIGINT', 'run', 130], ['SIGINT', 'tui', 130],
  ] as const)('drains the CLI on %s during %s', async (signal, command, code) => {
    const { root, profile, records } = setup('stall');
    fs.writeFileSync(path.join(root, 'handsfree.config.json'), JSON.stringify({
      workspaceRoot: path.join(root, 'runs'),
      agents: { fixture: profile },
      orchestration: { provider: 'acp', acp: { agent: 'fixture' } },
      limits: { handshakeTimeoutMs: 60_000 },
    }));
    const args = command === 'tui' ? [] : [command, 'hello'];
    const host = spawn(process.execPath, ['--import', loader, cli, main, ...args], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanup.push(() => { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); });
    let stderr = '';
    host.stderr.on('data', (chunk) => { stderr += chunk; });
    host.stdout.resume();
    const exited = new Promise<number | null>((resolve, reject) => {
      host.once('error', reject);
      host.once('exit', resolve);
    });
    await ready(records, () => stderr);
    host.kill(signal);
    // A second termination request must still wait for the same cleanup.
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (host.exitCode === null && host.signalCode === null) host.kill(signal);
    expect(await exited, stderr).toBe(code);
    await gone(records);
  });
});
