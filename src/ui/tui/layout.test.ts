import { describe, expect, it } from 'vitest';
import { HeightIndex, entryText, heightOf, totalHeight } from './layout.js';
import type { ViewItem } from '../view-model.js';

function item(text: string, extra: Partial<ViewItem> = {}): ViewItem {
  return {
    key: text,
    role: 'handsfree',
    depth: 0,
    marker: 'bullet',
    markerTone: 'normal',
    text,
    tone: 'normal',
    lines: [],
    gap: false,
    ...extra,
  };
}

/** Ten one-row items, so a row count reads as an index into them. */
const rows = Array.from({ length: 10 }, (_, index) => item(`row ${index}`));

describe('totalHeight', () => {
  it('invalidates prefix heights on edits, folding, clear and terminal resize', () => {
    const index = new HeightIndex();
    const long = item('한글 '.repeat(80));
    for (const [items, columns] of [
      [rows, 80], [[...rows, long], 80], [[...rows, long], 20],
      [[rows[0]!, long], 20], [[], 20], [[long], 80],
    ] as const) expect(index.total(items, columns)).toBe(totalHeight(items, columns));
  });
  it('adds up what every item takes, wrapping included', () => {
    expect(totalHeight(rows, 80)).toBe(10);
    const tall = item('x'.repeat(200), { gap: true });
    expect(totalHeight([...rows, tall], 80)).toBe(10 + heightOf(tall, 80));
  });
});

describe('heightOf', () => {
  it('starts prose beside its label and aligns later lines with the body', () => {
    const code = item('const a = 1;\nconst b = 2;', { label: 'claude' });
    expect(heightOf(code, 80)).toBe(2);
    expect(heightOf({ ...code, prose: true }, 80)).toBe(2);
    expect(entryText({ ...code, prose: true }, 80)).toBe('const a = 1;\n        const b = 2;');
  });

  it('counts the gap, every wrapped headline row and every detail row', () => {
    const tall = item('x'.repeat(150), {
      gap: true,
      lines: [
        { text: 'one', tone: 'muted' },
        { text: 'y'.repeat(150), tone: 'muted' },
      ],
    });
    // The gap, two wrapped headline rows, then the details: one row and two.
    expect(heightOf(tall, 80)).toBe(6);
  });

  it('measures a CJK speaker label by its cells, not its characters', () => {
    const reply = item('a'.repeat(20) + '\nnext line', { label: '클로드', prose: true });
    // Eight cells of label take the twenty a's to two rows, and the next line is a third.
    expect(heightOf(reply, 20)).toBe(3);
  });
});
