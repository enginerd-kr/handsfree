import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type { ViewItem } from '../view-model.js';

/** Width of the gutter column every row reserves for its glyph. */
export const GUTTER = 2;
/** Extra indent the continuation rows sit at, inside the item's own indent. */
export const DETAIL_INDENT = 2;

/**
 * Measured heights, kept per item. Wrapping is the expensive part of layout —
 * `wrap-ansi` walks every escape and code point — and every render asks for
 * the same items again. The items are rebuilt whenever the transcript or the
 * markdown changes, and that is exactly what drops a stale entry.
 */
const measured = new WeakMap<ViewItem, { columns: number; height: number }>();

/**
 * How many terminal rows an item takes. Ink wraps with `wrap-ansi` under
 * `{trim: false, hard: true}`, so the same call is used here rather than a
 * character count: word breaks and double-width CJK both move a line, and a
 * block that measures short by a row lets the live pane draw over the prompt.
 */
export function heightOf(item: ViewItem, columns: number): number {
  const hit = measured.get(item);
  if (hit?.columns === columns) return hit.height;
  const indent = item.depth * 2;
  let rows = item.gap ? 1 : 0;
  rows += lines(headline(item, columns), width(columns, indent));
  const detail = width(columns, indent + DETAIL_INDENT);
  for (const line of item.lines) rows += lines(line.text, detail);
  measured.set(item, { columns, height: rows });
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

/** How many rows the items occupy between them. */
export function totalHeight(items: readonly ViewItem[], columns: number): number {
  let rows = 0;
  for (const item of items) rows += heightOf(item, columns);
  return rows;
}

/** Reuse the measured prefix of immutable rows already printed to scrollback. */
export class HeightIndex {
  private items: readonly ViewItem[] = [];
  private sums = [0];
  private columns = 0;

  total(items: readonly ViewItem[], columns: number): number {
    let same = 0;
    if (columns === this.columns) {
      while (same < items.length && items[same] === this.items[same]) same++;
    }
    this.sums.length = same + 1;
    for (let at = same; at < items.length; at++) this.sums.push(this.sums[at]! + heightOf(items[at]!, columns));
    this.items = items;
    this.columns = columns;
    return this.sums[items.length]!;
  }
}

function width(columns: number, indent: number): number {
  return Math.max(1, columns - indent - GUTTER);
}

function lines(text: string, max: number): number {
  if (text === '') return 1;
  return wrapAnsi(text, max, { trim: false, hard: true }).split('\n').length;
}
