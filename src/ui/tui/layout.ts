import wrapAnsi from 'wrap-ansi';
import type { ViewItem } from '../view-model.js';

/** Width of the gutter column every row reserves for its glyph. */
const GUTTER = 2;
/** Extra indent the continuation rows sit at, inside the item's own indent. */
const DETAIL_INDENT = 2;

/** Where one item ends up on screen, so a click can be traced back to it. */
export interface Placement {
  item: ViewItem;
  /** First screen row the item occupies, counting from the top of the frame. */
  top: number;
  /** One past the last row. */
  bottom: number;
}

/**
 * How many terminal rows an item takes. Ink wraps with `wrap-ansi` under
 * `{trim: false, hard: true}`, so the same call is used here rather than a
 * character count: word breaks and double-width CJK both move a line, and a
 * click that is one row off lands on the wrong task.
 */
export function heightOf(item: ViewItem, columns: number): number {
  const indent = item.depth * 2;
  let rows = item.gap ? 1 : 0;
  rows += lines(headline(item), width(columns, indent));
  const detail = width(columns, indent + DETAIL_INDENT);
  for (const line of item.lines) rows += lines(line.text, detail);
  return rows;
}

/** The text of the first row, including the label that wraps along with it. */
export function headline(item: ViewItem): string {
  return `${item.label ? `${item.label}  ` : ''}${item.text}`;
}

/**
 * Lays the visible items out from a starting row. The caller owns whatever sits
 * above the transcript; `from` is the row where the first item begins.
 */
export function placeItems(
  items: readonly ViewItem[],
  columns: number,
  from: number,
): Placement[] {
  const placements: Placement[] = [];
  let row = from;
  for (const item of items) {
    const height = heightOf(item, columns);
    placements.push({ item, top: row, bottom: row + height });
    row += height;
  }
  return placements;
}

/** What is drawn at `row`, if anything. */
export function itemAt(placements: readonly Placement[], row: number): ViewItem | undefined {
  return placements.find((placement) => row >= placement.top && row < placement.bottom)?.item;
}

/**
 * The tail of the transcript that fits in `budget` rows. Rows are measured, not
 * counted: one tool call with its output is worth several plain lines, and
 * slicing by item would push the newest work off the screen.
 */
export function lastFitting(
  items: readonly ViewItem[],
  budget: number,
  columns: number,
): ViewItem[] {
  let used = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    used += heightOf(items[index]!, columns);
    if (used > budget) return items.slice(Math.min(index + 1, items.length - 1));
  }
  return [...items];
}

function width(columns: number, indent: number): number {
  return Math.max(1, columns - indent - GUTTER);
}

function lines(text: string, max: number): number {
  if (text === '') return 1;
  return wrapAnsi(text, max, { trim: false, hard: true }).split('\n').length;
}
