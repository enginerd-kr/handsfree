import { describe, expect, it } from 'vitest';
import { Transcript } from '../workspace/transcript.js';
import { shortTokens, spendOf, tokensOf } from './usage.js';

describe('spendOf', () => {
  it('adds each agent up from its stops, and the orchestrator from its calls', () => {
    const t = new Transcript();
    t.append({ type: 'usage', purpose: 'plan', promptChars: 4_000, replyChars: 200, promptTokens: 1_000, completionTokens: 50 });
    t.append({ type: 'usage', purpose: 'narrate', promptChars: 2_000, replyChars: 100, promptTokens: 500, completionTokens: 25 });
    // A task's own usage record is about characters relayed, not tokens spent.
    t.append({ type: 'usage', purpose: 'task', taskId: 1, promptChars: 900, replyChars: 300, relayedChars: 100 });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'one' });
    t.append({
      type: 'stop',
      taskId: 1,
      agentId: 'claude',
      sessionId: 's',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 1_000, cachedWriteTokens: 200, totalTokens: 1_320 },
    });
    t.append({ type: 'delegation', taskId: 2, agentId: 'claude', sessionId: 's', task: 'two' });
    t.append({ type: 'stop', taskId: 2, agentId: 'claude', sessionId: 's', stopReason: 'cancelled' });
    t.append({ type: 'delegation', taskId: 3, agentId: 'gemini', sessionId: 'g', task: 'three' });
    t.append({
      type: 'stop',
      taskId: 3,
      agentId: 'gemini',
      sessionId: 'g',
      stopReason: 'end_turn',
      usage: { inputTokens: 700, outputTokens: 30, totalTokens: 730 },
    });

    const spend = spendOf(t.all());
    expect(spend.orchestrator).toEqual({
      tokens: 1_575,
      inputTokens: 1_500,
      outputTokens: 75,
      cachedTokens: 0,
      turns: 2,
      counted: 2,
      estimated: false,
    });
    expect(spend.agents['claude']).toEqual({
      tokens: 1_320,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 1_200,
      turns: 2,
      counted: 1,
      estimated: false,
    });
    expect(spend.agents['gemini']).toMatchObject({ tokens: 730, turns: 1, counted: 1 });
    // By model: the records name none, so each party stands under its own name.
    expect(spend.models.map(({ label, spend }) => [label, spend.tokens])).toEqual([
      ['orchestrator', 1_575],
      ['claude', 1_320],
      ['gemini', 730],
    ]);
  });

  it('keeps each figure with the model that earned it when a party moves models mid-run', () => {
    const t = new Transcript();
    t.append({ type: 'usage', purpose: 'plan', model: 'gemini:flash', promptChars: 400, replyChars: 40, promptTokens: 100, completionTokens: 10 });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'one' });
    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn', model: 'opus', usage: { inputTokens: 1_000, outputTokens: 0, totalTokens: 1_000 } });
    t.append({ type: 'usage', purpose: 'plan', model: 'claude:haiku', promptChars: 400, replyChars: 40, promptTokens: 200, completionTokens: 20 });
    t.append({ type: 'delegation', taskId: 2, agentId: 'claude', sessionId: 's', task: 'two' });
    t.append({ type: 'stop', taskId: 2, agentId: 'claude', sessionId: 's', stopReason: 'end_turn', model: 'haiku', usage: { inputTokens: 300, outputTokens: 0, totalTokens: 300 } });
    t.append({ type: 'delegation', taskId: 3, agentId: 'claude', sessionId: 's', task: 'three' });
    t.append({ type: 'stop', taskId: 3, agentId: 'claude', sessionId: 's', stopReason: 'end_turn', model: 'opus', usage: { inputTokens: 500, outputTokens: 0, totalTokens: 500 } });

    const spend = spendOf(t.all());
    // The party's own total is whole; the models split it, first used first.
    expect(spend.agents['claude']).toMatchObject({ tokens: 1_800, turns: 3 });
    expect(spend.orchestrator).toMatchObject({ tokens: 330, turns: 2 });
    expect(spend.models.map(({ label, spend }) => [label, spend.tokens, spend.turns])).toEqual([
      ['gemini:flash', 110, 1],
      ['opus', 1_500, 2],
      ['claude:haiku', 220, 1],
      ['haiku', 300, 1],
    ]);
  });

  it('estimates the orchestrator from characters where the endpoint counted nothing', () => {
    const t = new Transcript();
    t.append({ type: 'usage', purpose: 'plan', promptChars: 4_000, replyChars: 400 });
    t.append({ type: 'usage', purpose: 'plan', promptChars: 4_000, replyChars: 400, promptTokens: 900, completionTokens: 100 });

    const spend = spendOf(t.all());
    expect(spend.orchestrator).toMatchObject({ tokens: 2_100, turns: 2, counted: 1, estimated: true });
  });

  it('keeps how full each context is, from the last word the agent had on it', () => {
    const t = new Transcript();
    for (const used of [10_000, 25_000]) {
      t.append({
        type: 'session_update',
        agentId: 'claude',
        sessionId: 's',
        update: { sessionUpdate: 'usage_update', used, size: 200_000 },
      });
    }

    const spend = spendOf(t.all());
    expect(spend.agents['claude']).toMatchObject({ tokens: 0, turns: 0, context: { used: 25_000, size: 200_000 } });
  });
});

describe('tokensOf', () => {
  it('takes the agent\'s own total, or adds the parts up without one', () => {
    expect(tokensOf({ inputTokens: 1, outputTokens: 2, totalTokens: 99 })).toBe(99);
    expect(
      tokensOf({ inputTokens: 1, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 4, thoughtTokens: 5 }),
    ).toBe(15);
  });
});

describe('shortTokens', () => {
  it('writes a count at the width a roster can afford', () => {
    expect(shortTokens(0)).toBe('0');
    expect(shortTokens(850)).toBe('850');
    expect(shortTokens(1_000)).toBe('1k');
    expect(shortTokens(4_149)).toBe('4.1k');
    expect(shortTokens(9_960)).toBe('10k');
    expect(shortTokens(38_400)).toBe('38k');
    expect(shortTokens(999_499)).toBe('999k');
    expect(shortTokens(1_250_000)).toBe('1.3M');
  });
});
