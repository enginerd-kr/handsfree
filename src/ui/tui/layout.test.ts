import { describe, expect, it } from 'vitest';
import { heightOf, itemAt, placeItems, totalHeight, windowAt } from './layout.js';
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
