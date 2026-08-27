/**
 * Terminal mouse reporting.
 *
 * Reports must be handled through Ink's `useInput`. Ink owns stdin with a
 * `readable` listener; adding a `data` listener puts it into flowing mode and
 * can leave Ink without keyboard input after the prompt is remounted.
 *
 * The cost of tracking is real and worth stating: while it is on, the terminal
 * sends drags to us instead of selecting text, so selecting with the mouse needs
 * the usual override (Option on macOS, Shift elsewhere).
 */

/**
 * 1000 reports press and release, 1002 adds drag events, 1003 adds hover, and
 * 1006 asks for SGR encoding so coordinates past column 223 survive.
 */
const ON = '\u001B[?1000h\u001B[?1002h\u001B[?1003h\u001B[?1006h';
const OFF = '\u001B[?1006l\u001B[?1003l\u001B[?1002l\u001B[?1000l';

export interface MouseClick {
  /** 0-indexed screen column. */
  column: number;
  /** 0-indexed screen row. */
  row: number;
}

export type MouseEvent =
  | { type: 'click'; column: number; row: number }
  | { type: 'hover'; column: number; row: number }
  | { type: 'wheel'; direction: 'up' | 'down'; column: number; row: number };

/**
 * Turns mouse reporting on and returns the function that turns it off. The
 * teardown is idempotent and also runs on exit, because a terminal left in
 * tracking mode keeps swallowing selection long after handsfree is gone.
 */
export function trackMouse(stdout: NodeJS.WriteStream | undefined): () => void {
  if (!stdout?.isTTY) return () => {};

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off('exit', stop);
    stdout.write(OFF);
  };

  stdout.write(ON);
  process.once('exit', stop);
  return stop;
}

/**
 * Asks the terminal where its cursor is (DSR). The answer arrives on stdin as
 * `ESC[row;colR`, which Ink hands to `useInput` like any other sequence. Mouse
 * rows are screen rows, but the frame starts wherever the shell prompt left it
 * and moves when the terminal scrolls — so the frame's place has to be
 * measured, and the cursor is the one thing on screen whose row is knowable:
 * Ink parks it on the line just under the frame.
 */
export const CURSOR_QUERY = '\u001B[6n';

/** Decode the answer to {@link CURSOR_QUERY}: the 0-indexed screen row. */
export function parseCursorReport(input: string): number | undefined {
  const match = /^\[(\d+);\d+R$/.exec(input);
  return match ? Number(match[1]) - 1 : undefined;
}

/**
 * Decode one SGR report as Ink delivers it: without the leading escape byte.
 * Ink buffers incomplete CSI sequences itself, so reports split across stdin
 * chunks still arrive here as one value.
 */
export function parseMouseEvent(input: string): MouseEvent | undefined {
  const match = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!match) return undefined;

  const [, button, column, row, kind] = match;
  // Bit 5 marks motion and bit 6 the wheel; neither is a click. The low two
  // bits are the button. 35 (motion + button 3) is movement without a button
  // held, which is exactly a hover report in DECSET 1003 mode; 64 and 65 are
  // the wheel turning away from and towards the hand.
  const code = Number(button);
  const point = { column: Number(column) - 1, row: Number(row) - 1 };
  if ((code & 64) !== 0) {
    const direction = (code & 1) === 0 ? 'up' : 'down';
    return (code & 2) === 0 ? { type: 'wheel', direction, ...point } : undefined;
  }
  if ((code & 32) !== 0) {
    return (code & 3) === 3 ? { type: 'hover', ...point } : undefined;
  }
  if (kind !== 'm' || (code & 3) !== 0) return undefined;

  return { type: 'click', ...point };
}

/**
 * Ink may also deliver a report to `useInput` as plain text, depending on how it
 * parsed the chunk. That copy is not used for anything — it is only recognised
 * so it can be kept out of the prompt.
 */
export function isMouseReport(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}
