import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config/schema.js';
import { Transcript } from '../workspace/transcript.js';
import { BudgetManager } from './budget.js';
import { metered } from './usage.js';

describe('execution budgets', () => {
  it('permits measured ACP input overhead but separately stops excessive generated output', () => {
    const manager = new BudgetManager(ConfigSchema.parse({}), new Transcript());
    const cached = manager.begin('a', 'a', true, 50_000);
    const charge = cached.finish({ tokens: 50_000, inputTokens: 1000, cachedReadTokens: 48_500, outputTokens: 500, estimated: false });
    expect(charge.failed).toBe(false);
    const verbose = manager.begin('a', 'a', true, 50_000);
    verbose.observe(54_100, 4100);
    expect(verbose.signal.aborted).toBe(true);
    expect(verbose.finish({ tokens: 54_100, inputTokens: 50_000, outputTokens: 4100, estimated: false }).failed).toBe(true);
    expect(() => manager.begin('a', 'a', true, 50_000, { maxTokens: 32_000 })).toThrow('task budget');
  });
  it('reserves remaining tokens before concurrent admissions and reconciles actual usage', () => {
    const manager = new BudgetManager(ConfigSchema.parse({ budget: { maxTokens: 100, maxTaskTokens: 100 } }), new Transcript());
    const first = manager.begin('a', 'a', true, 60);
    expect(() => manager.begin('b', 'b', true, 60)).toThrow('Run token budget');
    first.finish({ tokens: 10, inputTokens: 8, outputTokens: 2, estimated: false });
    const second = manager.begin('b', 'b', true, 60);
    second.finish({ tokens: 15, inputTokens: 10, outputTokens: 5, estimated: true });
    expect(manager.totals()).toMatchObject({ tokens: 25, frontierTokens: 25, estimatedCalls: 1 });
  });

  it('separates local tokens from frontier tokens and cancels a growing task', () => {
    const manager = new BudgetManager(ConfigSchema.parse({ budget: { maxFrontierTokens: 10, maxTaskTokens: 100 } }), new Transcript());
    const local = manager.begin('local', 'local', false, 50);
    const remote = manager.begin('remote', 'remote', true, 10);
    remote.observe(11);
    expect(remote.signal.aborted).toBe(true);
    local.finish({ tokens: 50, inputTokens: 40, outputTokens: 10, estimated: false });
    remote.finish({ tokens: 11, inputTokens: 10, outputTokens: 1, estimated: false });
    expect(manager.totals()).toMatchObject({ tokens: 61, frontierTokens: 11 });
  });

  it('accounts failed streamed calls and does not lose their usage', async () => {
    const transcript = new Transcript();
    const manager = new BudgetManager(ConfigSchema.parse({}), transcript);
    const llm = metered({ async chat(_messages, options) {
      options?.onDelta?.('partial answer');
      options?.onUsage?.({ promptTokens: 100, completionTokens: 5, cachedTokens: 60 });
      throw new Error('connection closed');
    } }, 'plan', transcript, 'small', { manager, frontier: true, outputTokens: 20 });
    await expect(llm.chat([{ role: 'user', content: 'go' }])).rejects.toThrow('connection closed');
    expect(manager.totals().tokens).toBe(105);
    expect(transcript.all().find((r) => r.type === 'budget_usage')).toMatchObject({ usage: { failed: true, cachedReadTokens: 60, estimated: false } });
    expect(transcript.all().find((r) => r.type === 'usage')).toMatchObject({ replyChars: 14 });
  });

  it('requires prices for USD enforcement, and prices cached usage separately', () => {
    const manager = new BudgetManager(ConfigSchema.parse({ budget: { maxCostUsd: 1 }, prices: { small: { input: 1, output: 4, cachedRead: 0.1, cachedWrite: 2 } } }), new Transcript());
    expect(() => manager.begin('a', 'unknown', true, 10)).toThrow('requires configured prices');
    const lease = manager.begin('a', 'small', true, 100);
    const result = lease.finish({ tokens: 160, inputTokens: 10, outputTokens: 20, cachedReadTokens: 100, cachedWriteTokens: 30, estimated: false });
    expect(result.costUsd).toBeCloseTo(0.00016);
  });

  it('rejects completed planner calls whose final usage exceeds the budget', async () => {
    const transcript = new Transcript();
    const manager = new BudgetManager(ConfigSchema.parse({ budget: { maxTokens: 100 } }), transcript);
    const llm = metered({ async chat(_messages, options) {
      options?.onUsage?.({ promptTokens: 100, completionTokens: 50 });
      return '{"agent":"a"}';
    } }, 'plan', transcript, 'small', { manager, frontier: true, outputTokens: 20 });
    await expect(llm.chat([{ role: 'user', content: 'Go' }])).rejects.toThrow('exceeded');
    expect(manager.totals().tokens).toBe(150);
    expect(transcript.all().find((r) => r.type === 'budget_usage')).toMatchObject({ usage: { failed: true } });
  });
});
