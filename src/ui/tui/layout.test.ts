import { describe, expect, it } from 'vitest';
import { heightOf, itemAt, itemRows, placeItems, totalHeight, visualRows, windowAt } from './layout.js';
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
  it('adds up what every item takes, wrapping included', () => {
    expect(totalHeight(rows, 80)).toBe(10);
    const tall = item('x'.repeat(200), { gap: true });
    expect(totalHeight([...rows, tall], 80)).toBe(10 + heightOf(tall, 80));
  });
});

describe('itemRows', () => {
  it('gives a label its own row over prose, and a shared one over a one-line row', () => {
    const code = item('const a = 1;\nconst b = 2;', { label: 'claude' });
    expect(heightOf(code, 80)).toBe(2);
    expect(heightOf({ ...code, prose: true }, 80)).toBe(3);
  });

  it('places the headline past the gap and each detail line under the last', () => {
    const tall = item('x'.repeat(150), {
      gap: true,
      lines: [
        { text: 'one', tone: 'muted' },
        { text: 'y'.repeat(150), tone: 'muted' },
      ],
    });
    // The gap, two wrapped headline rows, then the details: one row and two.
    const rows = itemRows(tall, 80);
    expect(rows.headline).toBe(1);
    expect(rows.details).toEqual([3, 4]);
    expect(rows.height).toBe(heightOf(tall, 80));
  });
});

describe('visualRows', () => {
  it('mirrors heightOf row for row, wrapping and gaps included', () => {
    const tall = item('x'.repeat(150), { gap: true, lines: [{ text: 'done', tone: 'muted' }] });
    const all = [...rows.slice(0, 2), tall];
    expect(visualRows(all, 80)).toHaveLength(totalHeight(all, 80));
  });

  it('marks a row made by wrapping, and says where its cells start', () => {
    const wide = item('x'.repeat(100));
    const [first, second] = visualRows([wide], 80);
    expect(first).toMatchObject({ left: 2, wrapped: false });
    // 78 columns fit beside the gutter; the rest fall to the next row.
    expect(second).toMatchObject({ text: 'x'.repeat(22), left: 2, wrapped: true });
  });

  it('leaves the gutter and indent out of a detail row', () => {
    const detailed = item('call', { depth: 1, lines: [{ text: 'output', tone: 'muted' }] });
    const [, detail] = visualRows([detailed], 80);
    expect(detail).toMatchObject({ text: 'output', left: 6 });
  });
});

describe('windowAt', () => {
  it('takes the rows under `from`, and nothing above them', () => {
    const window = windowAt(rows, 4, 80, 3);
    expect(window.items.map((row) => row.text)).toEqual(['row 3', 'row 4', 'row 5', 'row 6']);
    expect(window.top).toBe(0);
  });

  it('keeps an item straddling the top edge, and says how much is above it', () => {
    // Two rows tall: the gap and the text. Landing between them clips one row.
    const tall = item('tall', { gap: true });
    const window = windowAt([tall, ...rows], 3, 80, 1);
    expect(window.items.map((row) => row.text)).toEqual(['tall', 'row 0', 'row 1']);
    expect(window.top).toBe(-1);
  });

  it('stops at the bottom edge rather than laying out the whole transcript', () => {
    expect(windowAt(rows, 2, 80, 0).items).toHaveLength(2);
  });

  it('gives back everything when it all fits', () => {
    const window = windowAt(rows, 20, 80, 0);
    expect(window.items).toHaveLength(10);
    expect(window.top).toBe(0);
  });

  it('places a clipped window so a click still lands on what is drawn', () => {
    const tall = item('tall', { gap: true });
    const { items, top } = windowAt([tall, ...rows], 3, 80, 1);
    const placements = placeItems(items, 80, 5 + top);
    // The header owns row 5; the clipped item's own first row sits under it.
    expect(itemAt(placements, 5)?.text).toBe('tall');
    expect(itemAt(placements, 6)?.text).toBe('row 0');
    expect(itemAt(placements, 7)?.text).toBe('row 1');
  });
});
