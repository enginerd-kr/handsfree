import { describe, expect, it } from 'vitest';
import type { VisualRow } from './layout.js';
import { highlightFor, order, paintSpan, selectedText, sliceCols, spanAt } from './selection.js';

const ESC = '';
const ON = `${ESC}[48;2;38;79;120m`;
const OFF = `${ESC}[49m`;

describe('order', () => {
  it('reads forward whichever way the drag went', () => {
    const up = order({ row: 5, col: 8 }, { row: 2, col: 3 });
    expect(up).toEqual({ start: { row: 2, col: 3 }, end: { row: 5, col: 8 } });
    const back = order({ row: 4, col: 9 }, { row: 4, col: 1 });
    expect(back).toEqual({ start: { row: 4, col: 1 }, end: { row: 4, col: 9 } });
  });
});

describe('spanAt', () => {
  const bounds = { start: { row: 2, col: 5 }, end: { row: 4, col: 3 } };

  it('clips the end rows to the drag and gives the middle wall to wall', () => {
    expect(spanAt(bounds, 1)).toBeUndefined();
    expect(spanAt(bounds, 2)).toEqual({ from: 5, to: Number.MAX_SAFE_INTEGER });
    expect(spanAt(bounds, 3)).toEqual({ from: 0, to: Number.MAX_SAFE_INTEGER });
    expect(spanAt(bounds, 4)).toEqual({ from: 0, to: 3 });
    expect(spanAt(bounds, 5)).toBeUndefined();
  });
});

describe('paintSpan', () => {
  it('washes exactly the cells between the columns', () => {
    expect(paintSpan('abcdef', 1, 3)).toBe(`a${ON}bcd${OFF}ef`);
  });

  it('keeps the wash under a style change inside the span', () => {
    const line = `ab${ESC}[31mcd${ESC}[0mef`;
    expect(paintSpan(line, 1, 4)).toBe(
      `a${ON}b${ESC}[31m${ON}cd${ESC}[0m${ON}e${OFF}f`,
    );
  });

  it('counts a wide character as the two cells it takes', () => {
    // 한 sits on cells 0-1, so a span from cell 2 starts at 글.
    expect(paintSpan('한글!', 2, 3)).toBe(`한${ON}글${OFF}!`);
  });
});

describe('highlightFor', () => {
  const bounds = { start: { row: 6, col: 4 }, end: { row: 7, col: 5 } };

  it('is nothing when the selection misses the block', () => {
    expect(highlightFor(undefined, 6, 2)).toBeUndefined();
    expect(highlightFor(bounds, 8, 2)).toBeUndefined();
  });

  it('answers for each wrapped line by its own row', () => {
    const repaint = highlightFor(bounds, 6, 2)!;
    // Row 6 from column 4, which is column 2 of the block's own cells.
    expect(repaint('abcdef', 0)).toBe(`ab${ON}cdef${OFF}`);
    // Row 7 up to column 5 — column 3 of the block.
    expect(repaint('abcdef', 1)).toBe(`${ON}abcd${OFF}ef`);
    expect(repaint('abcdef', 2)).toBe('abcdef');
  });
});

describe('sliceCols', () => {
  it('takes the cells between the columns, wide characters whole', () => {
    expect(sliceCols('abcdef', 1, 3)).toBe('bcd');
    expect(sliceCols('한글로 쓴 줄', 2, 5)).toBe('글로');
    expect(sliceCols('abc', 5, 9)).toBe('');
  });
});

describe('selectedText', () => {
  const row = (text: string, extra: Partial<VisualRow> = {}): VisualRow => ({
    text,
    left: 2,
    wrapped: false,
    ...extra,
  });

  it('takes the end rows from and to the drag, and whole rows between', () => {
    const rows = [row('first line'), row('second'), row('third line')];
    const text = selectedText(rows, { start: { row: 0, col: 8 }, end: { row: 2, col: 6 } });
    expect(text).toBe('line\nsecond\nthird');
  });

  it('heals a soft wrap back into one logical line', () => {
    const rows = [row('a headline that '), row('wrapped', { wrapped: true }), row('after')];
    const text = selectedText(rows, {
      start: { row: 0, col: 2 },
      end: { row: 2, col: Number.MAX_SAFE_INTEGER },
    });
    expect(text).toBe('a headline that wrapped\nafter');
  });

  it('keeps a wrap where the selection begins', () => {
    const rows = [row('a headline that '), row('wrapped', { wrapped: true })];
    const text = selectedText(rows, { start: { row: 1, col: 2 }, end: { row: 1, col: 79 } });
    expect(text).toBe('wrapped');
  });

  it('reads styled rows as their words alone', () => {
    const rows = [row(`${ESC}[31mred and loud${ESC}[0m`)];
    const text = selectedText(rows, { start: { row: 0, col: 2 }, end: { row: 0, col: 40 } });
    expect(text).toBe('red and loud');
  });

  it('gives a drag across a gap row nothing to keep', () => {
    const rows = [row('', { left: 0 })];
    const text = selectedText(rows, { start: { row: 0, col: 0 }, end: { row: 0, col: 10 } });
    expect(text).toBe('');
  });
});
