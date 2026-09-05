import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeAgent } from './fake-agent.js';
import { harness, type Harness } from './harness.js';
import { AgentTool } from '../src/orchestrator/conversation/tools/agent.js';
import { Planner } from '../src/models/planner.js';

const opened: Harness[] = [];
afterEach(async () => { for (const h of opened.splice(0)) await h.dispose(); });

describe('prepared agent sessions', () => {
  it('keeps only one empty session, preserves the saved session until adoption, and sets its model', async () => {
    const a = fakeAgent({ models: ['base', 'selected'], script: () => [] });
    const h = harness({ agents: { a } }); opened.push(h);
    const old = await h.runtime.pool.session('a');
    const connection = await h.runtime.pool.connection('a');
    const newSession = vi.spyOn(connection, 'newSession');
    connection.prepareSession('selected');
    connection.prepareSession('selected');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(newSession).toHaveBeenCalledTimes(1);
    expect(h.runtime.workspace.readSessionIds().a).toBe(old.sessionId);
    expect(h.runtime.pool.sessionId('a')).toBe(old.sessionId);
    await old.selectModel('selected');
    const fresh = await h.runtime.pool.rotate('a');
    expect(newSession).toHaveBeenCalledTimes(1);
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(fresh.currentModel()).toBe('selected');
    expect(h.runtime.workspace.readSessionIds().a).toBe(fresh.sessionId);
    expect(a.prompts).toHaveLength(0);
  });

  it('recovers from speculative setup failure and never consumes the used session', async () => {
    const a = fakeAgent({ script: () => [] });
    const h = harness({ agents: { a } }); opened.push(h);
    const old = await h.runtime.pool.session('a');
    const connection = await h.runtime.pool.connection('a');
    vi.spyOn(connection, 'newSession').mockRejectedValueOnce(new Error('temporary setup failure'));
    connection.prepareSession();
    const next = await connection.takePreparedSession();
    expect(next.sessionId).not.toBe(old.sessionId);
    expect(h.runtime.workspace.readSessionIds().a).toBe(old.sessionId);
    await h.runtime.close();
    await expect(connection.takePreparedSession()).rejects.toThrow('closed');
  });
});

describe('independent group execution', () => {
  it('starts both readers before either finishes, but serializes workspace changes and native tools', async () => {
    const a = fakeAgent({ script: () => [{ do: 'stall', ms: 80 }, { do: 'say', text: 'A' }] });
    const b = fakeAgent({ script: () => [{ do: 'stall', ms: 80 }, { do: 'say', text: 'B' }] });
    const h = harness({ agents: { a, b } }); opened.push(h);
    await Promise.all(['a', 'b'].map((id) => h.runtime.pool.session(id)));
    const tool = new AgentTool({ roster: () => ['a', 'b'].map((id) => ({ id, description: '' })),
      delegator: h.runtime.executor.delegator, transcript: h.runtime.transcript, workspace: h.runtime.workspace });
    const run = async (kind: 'answer' | 'change') => {
      const start = h.runtime.transcript.all().length;
      await tool.run({ agent: ['a', 'b'], kind, prompt: 'Independent work' }, { signal: new AbortController().signal });
      return h.runtime.transcript.all().slice(start).filter((r) => r.type === 'delegation' || r.type === 'stop').map((r) => r.type);
    };
    expect(await run('answer')).toEqual(['delegation', 'delegation', 'stop', 'stop']);
    expect(await run('change')).toEqual(['delegation', 'stop', 'delegation', 'stop']);
    h.runtime.config.agents.a!.command = 'codex-acp';
    expect(await run('answer')).toEqual(['delegation', 'stop', 'delegation', 'stop']);
    const timings = h.runtime.transcript.all().filter((r) => r.type === 'timing');
    expect(timings).toHaveLength(6);
    for (const timing of timings) {
      expect(timing.firstOutputMs).toBeGreaterThan(0);
      expect(timing.promptMs).toBeGreaterThanOrEqual(timing.firstOutputMs!);
      expect(timing.totalMs).toBeGreaterThanOrEqual(timing.queueMs + timing.sessionMs);
    }
    expect(timings.at(-1)!.queueMs).toBeGreaterThan(0);
  });
});

it('starts a replacement planner while old cleanup is pending, and joins cleanup on shutdown', async () => {
  let release!: () => void;
  const closing = new Promise<void>((resolve) => { release = resolve; });
  const old = { chat: async () => 'old', close: () => closing };
  const next = { chat: async () => 'new', close: vi.fn(async () => {}), prepare: vi.fn() };
  const planner = new Planner(old, old);
  await planner.replace(next);
  expect(next.prepare).toHaveBeenCalledOnce();
  expect(await planner.chat([])).toBe('new');
  let closed = false;
  const end = planner.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await end;
  expect(next.close).toHaveBeenCalledOnce();
});
