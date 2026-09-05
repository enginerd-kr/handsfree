import { describe, expect, it } from 'vitest';
import { estimateTokens } from './client.js';

describe('estimateTokens', () => {
  it('counts ASCII at four characters a token and the rest closer to one', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('안녕하세요')).toBe(4);
    expect(estimateTokens('')).toBe(0);
  });
});
