import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../config/schema.js';
import { Transcript } from '../../workspace/transcript.js';
import { UsageTracker } from './meter.js';
import { metered } from './usage.js';

describe('usage accounting without budgets', () => {
  it('records concurrent workers with large input and output, once per call, and replays totals', () => {
    const transcript = new Transcript();
    const config = ConfigSchema.parse({});
    const manager = new UsageTracker(config, transcript);
    const remote = manager.begin('a', 'a', true);
    const local = manager.begin('b', 'b', false);
    const charge = { tokens: 1_500_000, inputTokens: 1_000_000, outputTokens: 500_000, estimated: false };
    expect(remote.finish(charge).failed).toBe(false);
    remote.finish(charge);
    local.finish(charge);
    expect(manager.totals()).toMatchObject({ tokens: 3_000_000, frontierTokens: 1_500_000, unknownCostCalls: 1 });
    manager.close();
    const resumed = new UsageTracker(config, transcript);
    expect(resumed.totals()).toEqual(manager.totals());
    resumed.close();
  });

  it('accepts unknown prices and prices cached usage separately after model selection', () => {
    const manager = new UsageTracker(ConfigSchema.parse({ prices: { small: { input: 1, output: 4, cachedRead: 0.1, cachedWrite: 2 } } }), new Transcript());
    const unknown = manager.begin('a', 'unknown', true).finish({ tokens: 1, inputTokens: 1, outputTokens: 0, estimated: false });
    expect(unknown.costUsd).toBeUndefined();
    const lease = manager.begin('a', 'unknown', true);
    lease.setModel('small');
    const result = lease.finish({ tokens: 160, inputTokens: 10, outputTokens: 20, cachedReadTokens: 100, cachedWriteTokens: 30, estimated: false });
    expect(result.costUsd).toBeCloseTo(0.00016);
    manager.close();
  });

  it('records large planner replies without rejecting them', async () => {
    const transcript = new Transcript();
    const manager = new UsageTracker(ConfigSchema.parse({}), transcript);
    const reply = 'x'.repeat(100_000);
    const llm = metered({ async chat(_messages, options) {
      options?.onUsage?.({ promptTokens: 1_000_000, completionTokens: 25_000 });
      return reply;
    } }, 'plan', transcript, 'small', { manager, frontier: true });
    await expect(llm.chat([{ role: 'user', content: 'Go' }])).resolves.toBe(reply);
    expect(manager.totals().tokens).toBe(1_025_000);
    expect(transcript.all().find((r) => r.type === 'budget_usage')).toMatchObject({ usage: { failed: false } });
    manager.close();
  });

  it('accounts failed streamed calls without losing their usage', async () => {
    const transcript = new Transcript();
    const manager = new UsageTracker(ConfigSchema.parse({}), transcript);
    const llm = metered({ async chat(_messages, options) {
      options?.onDelta?.('partial answer');
      options?.onUsage?.({ promptTokens: 100, completionTokens: 5, cachedTokens: 60 });
      throw new Error('connection closed');
    } }, 'plan', transcript, 'small', { manager, frontier: true });
    await expect(llm.chat([{ role: 'user', content: 'go' }])).rejects.toThrow('connection closed');
    expect(manager.totals().tokens).toBe(105);
    expect(transcript.all().find((r) => r.type === 'budget_usage')).toMatchObject({ usage: { failed: true, cachedReadTokens: 60, estimated: false } });
    expect(transcript.all().find((r) => r.type === 'usage')).toMatchObject({ replyChars: 14 });
    manager.close();
  });
});
