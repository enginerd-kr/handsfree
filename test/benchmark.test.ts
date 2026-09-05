import { describe, expect, it } from 'vitest';
import { benchmark } from '../bench/run.js';

describe('comparable execution benchmark', () => {
  it('checks identical artifacts in all modes and measures orchestration overhead separately', async () => {
    const result = await benchmark();
    expect(result.mode).toBe('simulation');
    expect(result.rows.every((row) => row.successes === 2 && row.workerCalls === 2)).toBe(true);
    const conversation = result.rows.find((row) => row.mode === 'conversation')!;
    const structured = result.rows.find((row) => row.mode === 'structured')!;
    expect(conversation.plannerCalls).toBe(4);
    expect(structured.plannerCalls).toBe(0);
    expect(structured.totalTokens).toBeLessThan(conversation.totalTokens);
  });
});
