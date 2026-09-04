/**
 * The prompt's text as a set of lines. The draft is one string with a cursor
 * counted in code points; a line break is a character in it like any other,
 * so left and right walk across one on their own. What needs help is the
 * vertical: up and down inside a draft of several lines, and home and end,
 * which mean the line the cursor is on rather than the whole text.
 */

/** Where the line holding `cursor` begins and ends, both in code points. */
export function lineAround(value: string, cursor: number): { start: number; end: number } {
  const chars = [...value];
  const at = Math.min(Math.max(cursor, 0), chars.length);
  let start = at;
  while (start > 0 && chars[start - 1] !== '\n') start -= 1;
  let end = at;
  while (end < chars.length && chars[end] !== '\n') end += 1;
  return { start, end };
}

/**
 * The cursor one line up or down, keeping its column where the line there
 * is long enough and falling to that line's end where it is not. `undefined`
 * when there is no line that way — the top of the draft on the way up, the
 * bottom on the way down — so the caller can hand the key to whatever it
 * meant before the draft grew a second line.
 */
export function stepLine(value: string, cursor: number, direction: 'up' | 'down'): number | undefined {
  const chars = [...value];
  const { start, end } = lineAround(value, cursor);
  const column = Math.min(Math.max(cursor, 0), chars.length) - start;
  if (direction === 'up') {
    if (start === 0) return undefined;
    const above = lineAround(value, start - 1);
    return Math.min(above.start + column, above.end);
  }
  if (end >= chars.length) return undefined;
  const below = lineAround(value, end + 1);
  return Math.min(below.start + column, below.end);
}

/** How many rows the draft takes as typed: one, plus one per line break. */
export function lineCount(value: string): number {
  let count = 1;
  for (const char of value) if (char === '\n') count += 1;
  return count;
}
