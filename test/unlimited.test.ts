import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, methods } from '@agentclientprotocol/sdk';
import { ConfigSchema } from '../src/config/schema.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import { fakeAgent } from './fake-agent.js';

let open: Harness | undefined;
afterEach(async () => { vi.useRealTimers(); await open?.dispose(); open = undefined; });

describe('execution without configured limits', () => {
  it('does not restore retired settings from defaults or older config files', () => {
    const config = ConfigSchema.parse({
      budget: { maxTokens: 1, maxTaskTokens: 1, maxCostUsd: 0.01 },
      limits: { maxPlanSteps: 1, maxResultChars: 256, turnTimeoutMs: 1 },
      policy: { workspaceOnly: true, decisionTimeoutMs: 1 },
      orchestration: { maxHistoryMessages: 1, contextBudgetTokens: 1, maxOutputTokens: 1, maxRepairAttempts: 1,
        local: { timeoutMs: 1, maxOutputTokens: 1 }, acp: { timeoutMs: 1 } },
      execution: { maxParallel: 1, maxBatchTasks: 1, maxCandidates: 1, rotateContextRatio: 0.1, routingContextTokens: 256 },
    });
    for (const key of ['budget', 'limits', 'policy']) expect(config).not.toHaveProperty(key);
    expect(config.execution).toEqual({ routing: 'auto' });
    expect(Object.keys(config.orchestration).sort()).toEqual(['acp', 'local', 'provider', 'relayAnswers']);
    expect(config.orchestration.local).not.toHaveProperty('timeoutMs');
    expect(config.orchestration.local).not.toHaveProperty('maxOutputTokens');
    expect(config.orchestration.acp).not.toHaveProperty('timeoutMs');
  });

  it('repairs more than three invalid replies and executes more than 32 planning steps', async () => {
    const worker = fakeAgent({ script: () => [{ do: 'say', text: 'REPORT\noutcome: done\nsummary: checked' }] });
    const calls = Array.from({ length: 40 }, (_, n) => JSON.stringify({ action: 'call', tool: 'agent',
      input: { agent: 'worker', kind: 'answer', prompt: `Check item ${n}` } }));
    const llm = scriptedModel([...Array(5).fill('invalid JSON'), ...calls, JSON.stringify({ action: 'answer', message: 'All 40 checked.' })]);
    open = harness({ agents: { worker }, llm });
    await open.runtime.conversation.send('Check every item.');
    expect(worker.prompts).toHaveLength(40);
    expect(llm.seen).toHaveLength(46);
    expect(open.runtime.transcript.all().filter((r) => r.type === 'assistant').at(-1)).toMatchObject({ text: 'All 40 checked.' });
  });

  it('includes every candidate and runs batches larger than 64 across more than eight workers', async () => {
    const agents = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`worker${i}`, fakeAgent({ script: () => [
      { do: 'stall', ms: 20 }, { do: 'say', text: 'REPORT\noutcome: done\nsummary: checked' },
    ] })]));
    open = harness({ agents });
    const executor = open.runtime.executor;
    const request = { task: 'Check', kind: 'answer' as const, constraints: [], acceptanceCriteria: [], files: [], resolves: [] };
    expect(executor.candidates(request)).toHaveLength(12);
    let active = 0, peak = 0;
    open.runtime.transcript.on('record', (r) => {
      if (r.type === 'delegation') peak = Math.max(peak, ++active);
      if (r.type === 'stop') active--;
    });
    const tasks = Array.from({ length: 70 }, (_, i) => ({ id: String(i), request: { task: `Check ${i}`, kind: 'answer' as const, agent: `worker${i % 12}` } }));
    const results = await executor.batch({ tasks });
    expect(Object.values(results)).toHaveLength(70);
    expect(Object.values(results).every((result) => result.status === 'done')).toBe(true);
    expect(peak).toBe(12);
  });

  it('waits for initialization without a deadline and allows explicit cancellation', async () => {
    const worker = fakeAgent({ script: () => [] });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let app = agent({ name: 'starting' }).onRequest(methods.agent.initialize, async () => {
      entered();
      return new Promise<never>(() => {});
    });
    const originalTarget = worker.target;
    worker.target = () => ({ ...originalTarget(), connect: (client) => client.connect(app) });
    open = harness({ agents: { worker } });
    const controller = new AbortController();
    const work = open.runtime.executor.execute({ task: 'Check', agent: 'worker' }, controller.signal);
    await started;
    vi.useFakeTimers();
    let settled = false;
    void work.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(settled).toBe(false);
    controller.abort();
    expect((await work).status).toBe('cancelled');
    expect(open.runtime.pool.isOpen('worker')).toBe(false);
    vi.useRealTimers();
    app = worker.app;
    expect((await open.runtime.executor.execute({ task: 'Try again', agent: 'worker' })).status).toBe('done');
  });
});
