import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../config/schema.js';
import { Transcript } from '../../workspace/transcript.js';
import { UsageTracker } from './meter.js';
import { metered } from './usage.js';

describe('usage accounting', () => {
  it('records large completed planner calls and replays totals without changing success', async () => {
    const transcript = new Transcript();
    const config = ConfigSchema.parse({});
    const manager = new UsageTracker(config, transcript);
    const llm = metered({ async chat(_messages, options) {
      options?.onUsage?.({ promptTokens: 200_000, completionTokens: 10_000 });
      return 'review complete';
    } }, 'plan', transcript, 'small', { manager, frontier: true });
    await expect(llm.chat([{ role: 'user', content: 'Review the outcome.' }])).resolves.toBe('review complete');
    expect(manager.totals()).toMatchObject({ tokens: 210_000, frontierTokens: 210_000, unknownCostCalls: 1 });
    expect(transcript.all().find((r) => r.type === 'budget_usage')).toMatchObject({ usage: { failed: false } });
    manager.close();
    const resumed = new UsageTracker(config, transcript);
    expect(resumed.totals()).toEqual(manager.totals());
    resumed.close();
  });

  it('separates local usage, unknown prices, cached prices and provider-reported cost', () => {
    const manager = new UsageTracker(ConfigSchema.parse({ prices: { small: { input: 1, output: 4, cachedRead: 0.1, cachedWrite: 2 } } }), new Transcript());
    const charge = { tokens: 160, inputTokens: 10, outputTokens: 20, cachedReadTokens: 100, cachedWriteTokens: 30, estimated: false };
    expect(manager.record('a', 'unknown', true, charge).costUsd).toBeUndefined();
    expect(manager.record('a', 'small', true, charge).costUsd).toBeCloseTo(0.00016);
    expect(manager.record('a', 'small', true, { ...charge, costUsd: 2 }).costUsd).toBe(2);
    expect(manager.record('local', 'small', false, charge).costUsd).toBe(0);
    expect(manager.totals()).toMatchObject({ tokens: 640, frontierTokens: 480, unknownCostCalls: 1 });
    manager.close();
  });

  it('accounts failed streamed calls and does not lose their usage', async () => {
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
  });

});
