import { describe, expect, it } from 'vitest';
import { estimateMessages, estimateTokens, fitBudget, type ChatMessage } from './client.js';

describe('estimateTokens', () => {
  it('counts ASCII at four characters a token and the rest closer to one', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('안녕하세요')).toBe(4);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('fitBudget', () => {
  const system: ChatMessage = { role: 'system', content: 's'.repeat(40) };
  const turn = (n: number): ChatMessage[] => [
    { role: 'user', content: `u${n} ${'x'.repeat(40)}` },
    { role: 'assistant', content: `a${n} ${'y'.repeat(40)}` },
  ];
  const last: ChatMessage = { role: 'user', content: 'now' };

  it('returns the messages as they are when they fit', () => {
    const messages = [system, ...turn(1), last];
    expect(fitBudget(messages, 10_000)).toEqual(messages);
  });

  it('drops whole turns from the front, keeping the system prompt and the last line', () => {
    const messages = [system, ...turn(1), ...turn(2), ...turn(3), last];
    const fitted = fitBudget(messages, estimateMessages([system, ...turn(3), last]) + 1);
    expect(fitted[0]).toBe(system);
    expect(fitted.at(-1)).toBe(last);
    expect(fitted.map((message) => message.content.slice(0, 2))).toEqual(['ss', 'u3', 'a3', 'no']);
  });

  it('never leaves an assistant line leading the history', () => {
    const messages = [system, ...turn(1), ...turn(2), last];
    // Room for the tail of turn 1 by size, but not for its user line.
    const fitted = fitBudget(messages, estimateMessages([system, turn(1)[1]!, ...turn(2), last]));
    expect(fitted[1]?.role).toBe('user');
    expect(fitted[1]?.content.startsWith('u2')).toBe(true);
  });

  it('returns the system prompt and the line alone when nothing else can go', () => {
    const messages = [system, ...turn(1), last];
    expect(fitBudget(messages, 1)).toEqual([system, last]);
  });
});
