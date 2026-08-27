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

/** How many rows the whole transcript occupies. */
export function totalHeight(items: readonly ViewItem[], columns: number): number {
  let rows = 0;
  for (const item of items) rows += heightOf(item, columns);
  return rows;
}

/** The slice of the transcript on screen, and where its first row sits. */
export interface Window {
  /** The items with any rows inside the viewport. */
  items: ViewItem[];
  /**
   * Rows of the first item that sit above the viewport, as a negative offset —
   * what the drawn column is nudged up by, and what every placement below is
   * measured from. Zero when the first visible item starts on the first row.
   */
  top: number;
}

/**
 * The `budget` rows of the transcript starting `from` rows down it. Rows are
 * measured, not counted: one tool call with its output is worth several plain
 * lines, and slicing by item would let a single long answer swallow the
 * viewport. An item straddling either edge is kept whole and clipped when
 * drawn, so scrolling moves by rows rather than jumping by messages.
 */
export function windowAt(
  items: readonly ViewItem[],
  budget: number,
  columns: number,
  from: number,
): Window {
  const end = from + budget;
  const window: Window = { items: [], top: 0 };
  let row = 0;
  for (const item of items) {
    if (row >= end) break;
    const height = heightOf(item, columns);
    if (row + height > from) {
      if (window.items.length === 0) window.top = row - from;
      window.items.push(item);
    }
    row += height;
  }
  return window;
}

function width(columns: number, indent: number): number {
  return Math.max(1, columns - indent - GUTTER);
}

function lines(text: string, max: number): number {
  if (text === '') return 1;
  return wrapAnsi(text, max, { trim: false, hard: true }).split('\n').length;
}
