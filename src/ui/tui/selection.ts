/**
 * Text selection, the way a terminal does it: linear, from the cell the button
 * went down on to the cell under the pointer, wrapping across line ends.
 *
 * The selection lives in cells rather than in items so a drag picks up exactly
 * the characters it crossed — Claude Code's fullscreen mode keeps a whole
 * screen buffer and restyles its cells for this; here the same effect comes
 * from Ink's `Transform`, which hands over each wrapped line of a text block
 * to be repainted, and from `visualRows`, which rebuilds those same lines when
 * the text is copied. Both lean on the one wrapping call Ink itself uses, so
 * what is highlighted, what is copied, and what is on screen are one thing.
 */
import stringWidth from 'string-width';
import { stripAnsi } from './clipboard.js';
import type { VisualRow } from './layout.js';
import { SELECTION } from './theme.js';

/** One cell: a screen row and the column of the cell in it, both 0-indexed. */
export interface Point {
  row: number;
  col: number;
}

/** A selection with its ends put in reading order. */
export interface Bounds {
  start: Point;
  end: Point;
}

/** Reading order: the earlier row, and on the same row the earlier column. */
export function order(anchor: Point, focus: Point): Bounds {
  const before =
    anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col);
  return before ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/**
 * The columns the selection covers on `row`, inclusive, or nothing when the
 * row is outside it. Rows between the ends are covered wall to wall.
 */
export function spanAt(
  bounds: Bounds,
  row: number,
): { from: number; to: number } | undefined {
  if (row < bounds.start.row || row > bounds.end.row) return undefined;
  return {
    from: row === bounds.start.row ? bounds.start.col : 0,
    to: row === bounds.end.row ? bounds.end.col : Number.MAX_SAFE_INTEGER,
  };
}

/** Graphemes, so a flag or a composed hangul syllable is one unit, not four. */
const graphemes = new Intl.Segmenter();

/**
 * The selection wash, painted straight into the line: a solid background that
 * keeps each character's own colour, the way native selection does. Inverse
 * video would read fine over plain text but fragments over highlighted code —
 * every foreground colour becomes a different stripe.
 */
const RGB = [1, 3, 5].map((at) => Number.parseInt(SELECTION.slice(at, at + 2), 16));
const WASH_ON = `\u001B[48;2;${RGB.join(';')}m`;
const WASH_OFF = '\u001B[49m';

/**
 * Repaints the cells of `line` between columns `from` and `to` (inclusive)
 * with the selection background. The line may carry any styling of its own;
 * the wash is re-asserted after every escape inside the span, because any of
 * them may be a reset that would otherwise take the background with it.
 */
export function paintSpan(line: string, from: number, to: number): string {
  let out = '';
  let col = 0;
  let washed = false;
  for (const part of line.split(/(\u001B\[[0-9;]*m)/)) {
    if (part === '') continue;
    if (part.startsWith('\u001B')) {
      out += part;
      if (washed) out += WASH_ON;
      continue;
    }
    for (const { segment } of graphemes.segment(part)) {
      const inside = col >= from && col <= to;
      if (inside !== washed) {
        out += inside ? WASH_ON : WASH_OFF;
        washed = inside;
      }
      out += segment;
      col += Math.max(1, stringWidth(segment));
    }
  }
  return washed ? out + WASH_OFF : out;
}

/**
 * The line-repainter for one text block, or nothing when the selection misses
 * it entirely. `top` is the screen row of the block's first line and `left`
 * the column its cells start at; Ink's `Transform` calls the returned function
 * once per wrapped line, and each line answers for its own row.
 */
export function highlightFor(
  bounds: Bounds | undefined,
  top: number,
  left: number,
): ((line: string, index: number) => string) | undefined {
  if (!bounds || top > bounds.end.row) return undefined;
  return (line, index) => {
    const span = spanAt(bounds, top + index);
    if (!span) return line;
    const to = span.to - left;
    if (to < 0) return line;
    return paintSpan(line, Math.max(0, span.from - left), to);
  };
}

/** The cells of `text` from column `from` through `to`, inclusive. */
export function sliceCols(text: string, from: number, to: number): string {
  let out = '';
  let col = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (col > to) break;
    if (col >= from) out += segment;
    col += Math.max(1, stringWidth(segment));
  }
  return out;
}

/**
 * The text the selection holds, rebuilt from the transcript's rows. A row that
 * exists only because the one above it wrapped is joined back on — the copy
 * carries the logical line, not the width of the window it was read in — and
 * each logical line sheds the trailing space the layout gave it.
 */
export function selectedText(rows: readonly VisualRow[], bounds: Bounds): string {
  const lines: string[] = [];
  for (let at = Math.max(0, bounds.start.row); at <= bounds.end.row; at++) {
    const row = rows[at];
    if (row === undefined) break;
    const span = spanAt(bounds, at);
    if (!span) continue;
    const text = sliceCols(
      stripAnsi(row.text),
      Math.max(0, span.from - row.left),
      span.to === Number.MAX_SAFE_INTEGER ? span.to : Math.max(-1, span.to - row.left),
    );
    if (row.wrapped && at > bounds.start.row && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines.map((line) => line.replace(/\s+$/u, '')).join('\n');
}
