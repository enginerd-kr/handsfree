import { describe, expect, it } from 'vitest';
import { MASCOT, MASCOT_BLINK } from './theme.js';

describe('the welcome mark', () => {
  // The header is a fixed number of rows of a fixed width — that is what a
  // click's row is measured against — so a blink may only swap glyphs.
  it('keeps its shape while it blinks', () => {
    expect(MASCOT_BLINK).toHaveLength(MASCOT.length);
    expect(MASCOT_BLINK.map((line) => [...line].length)).toEqual(
      MASCOT.map((line) => [...line].length),
    );
  });
});
