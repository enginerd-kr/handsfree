import { describe, expect, it } from 'vitest';
import { isKittyQueryReply } from './keys.js';

describe('isKittyQueryReply', () => {
  it('knows the answer to a kitty keyboard query, whatever flags it carries', () => {
    expect(isKittyQueryReply('[?0u')).toBe(true);
    expect(isKittyQueryReply('[?31u')).toBe(true);
  });

  it('leaves cursor reports, mouse reports and plain text alone', () => {
    expect(isKittyQueryReply('[12;1R')).toBe(false);
    expect(isKittyQueryReply('[<0;12;5m')).toBe(false);
    expect(isKittyQueryReply('?0u')).toBe(false);
  });
});
