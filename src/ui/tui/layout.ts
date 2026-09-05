import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type { ViewItem } from '../view-model.js';

/** Width of the gutter column every row reserves for its glyph. */
export const GUTTER = 2;
/** Extra indent the continuation rows sit at, inside the item's own indent. */
export const DETAIL_INDENT = 2;

/** Where one item ends up on screen, so a click can be traced back to it. */
export interface Placement {
  item: ViewItem;
  /** First screen row the item occupies, counting from the top of the frame. */
  top: number;
  /** One past the last row. */
  bottom: number;
}

/** Where an item's blocks sit inside it, counted in rows from its first row. */
export interface ItemRows {
  /** Row of the headline's first line — past the gap, when there is one. */
  headline: number;
  /** Row each continuation line starts on; one entry per `item.lines`. */
  details: number[];
  /** All of it: the height `heightOf` reports. */
  height: number;
}

/**
 * Measured layouts, kept per item. Wrapping is the expensive part of layout —
 * `wrap-ansi` walks every escape and code point — and every scroll step asks
 * for the same items again, which without this re-wraps the whole transcript
 * per turn of the wheel. The items are rebuilt whenever the transcript or the
 * markdown changes, and that is exactly what drops a stale entry.
 */
const measured = new WeakMap<ViewItem, { columns: number; rows: ItemRows }>();

/**
 * How many terminal rows an item takes, and where each of its blocks lands.
 * Ink wraps with `wrap-ansi` under `{trim: false, hard: true}`, so the same
 * call is used here rather than a character count: word breaks and
 * double-width CJK both move a line, and a click that is one row off lands on
 * the wrong task — as would a selection.
 */
export function itemRows(item: ViewItem, columns: number): ItemRows {
  const hit = measured.get(item);
  if (hit?.columns === columns) return hit.rows;
  const indent = item.depth * 2;
  let row = item.gap ? 1 : 0;
  const head = row;
  row += lines(headline(item, columns), width(columns, indent));
  const details: number[] = [];
  const detail = width(columns, indent + DETAIL_INDENT);
  for (const line of item.lines) {
    details.push(row);
    row += lines(line.text, detail);
  }
  const rows = { headline: head, details, height: row };
  measured.set(item, { columns, rows });
  return rows;
}

/** How many terminal rows an item takes. */
export function heightOf(item: ViewItem, columns: number): number {
  return itemRows(item, columns).height;
}

/**
 * One terminal row of an item's text, as a selection sees it: the wrapped
 * segment (still styled), the column its first cell sits at, and whether it
 * only exists because the line above it ran out of room — a soft wrap, whose
 * break a copy should heal rather than keep.
 */
export interface VisualRow {
  text: string;
  left: number;
  wrapped: boolean;
}

/**
 * Every row of the transcript, in the exact wrapping the terminal shows. The
 * gutter and indent are left out: like the glyph column of any editor, they
 * are furniture rather than text, so a selection neither highlights nor
 * copies them. A gap row is an empty line.
 */
export function visualRows(items: readonly ViewItem[], columns: number): VisualRow[] {
  const rows: VisualRow[] = [];
  const wrap = (text: string, max: number, left: number) => {
    for (const [index, line] of wrapAnsi(text, max, { trim: false, hard: true })
      .split('\n')
      .entries()) {
      rows.push({ text: line, left, wrapped: index > 0 });
    }
  };
  for (const item of items) {
    const indent = item.depth * 2;
    if (item.gap) rows.push({ text: '', left: 0, wrapped: false });
    // Every headline sits one gutter in.
    const head = indent + GUTTER;
    const prefix = labelWidth(item, columns);
    if (prefix > 0) {
      let first = true;
      for (const logical of item.text.split('\n')) {
        for (const [index, text] of wrapAnsi(logical, textWidth(item, columns), { trim: false, hard: true }).split('\n').entries()) {
          rows.push({
            text: first ? `${item.label}  ${text}` : text,
            left: first ? head : head + prefix,
            wrapped: index > 0,
          });
          first = false;
        }
      }
    } else {
      wrap(headline(item, columns), width(columns, indent), head);
    }
    for (const line of item.lines) {
      wrap(line.text, width(columns, indent + DETAIL_INDENT), indent + DETAIL_INDENT + GUTTER);
    }
  }
  return rows;
}

/** The text of the first row, including the label that wraps along with it. */
export function headline(item: ViewItem, columns: number): string {
  return `${item.label ? `${item.label}  ` : ''}${entryText(item, columns)}`;
}

/** Reserve a label column for prose, unless the window cannot fit it. */
function labelWidth(item: ViewItem, columns: number): number {
  const size = item.prose && item.label ? stringWidth(`${item.label}  `) : 0;
  return size < width(columns, item.depth * 2) ? size : 0;
}

/** The width markdown and wrapping get after an inline speaker's name. */
export function textWidth(item: ViewItem, columns: number): number {
  return width(columns, item.depth * 2) - labelWidth(item, columns);
}

/** Align continuation lines and code with the first word beside the name. */
export function entryText(item: ViewItem, columns: number): string {
  const prefix = labelWidth(item, columns);
  if (prefix === 0) return item.text;
  return wrapAnsi(item.text, textWidth(item, columns), { trim: false, hard: true })
    .replace(/\n/g, `\n${' '.repeat(prefix)}`);
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
