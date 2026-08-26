import { describe, expect, it } from 'vitest';
import { CURSOR_QUERY, isMouseReport, parseCursorReport, parseMouseEvent, trackMouse } from './mouse.js';

const ESC = '';

function fakeStdout(isTTY: boolean) {
  const written: string[] = [];
  return {
    written,
    stream: { isTTY, write: (text: string) => written.push(text) } as unknown as NodeJS.WriteStream,
  };
}

describe('parseMouseEvent', () => {
  it('decodes a left-button release as a click', () => {
    expect(parseMouseEvent('[<0;12;5m')).toEqual({ type: 'click', column: 11, row: 4 });
  });

  it('decodes all-motion reports with no button held as hover', () => {
    expect(parseMouseEvent('[<35;12;5M')).toEqual({ type: 'hover', column: 11, row: 4 });
  });

  it('ignores presses, drags, wheel and other buttons', () => {
    expect(parseMouseEvent('[<0;12;5M')).toBeUndefined();
    expect(parseMouseEvent('[<32;12;5M')).toBeUndefined();
    expect(parseMouseEvent('[<64;12;5m')).toBeUndefined();
    expect(parseMouseEvent('[<2;12;5m')).toBeUndefined();
  });
});

describe('parseCursorReport', () => {
  it('decodes the answer to a cursor query as a 0-indexed row', () => {
    expect(CURSOR_QUERY).toBe(`${ESC}[6n`);
    expect(parseCursorReport('[12;1R')).toBe(11);
  });

  it('leaves mouse reports and plain text alone', () => {
    expect(parseCursorReport('[<0;12;5m')).toBeUndefined();
    expect(parseCursorReport('hello')).toBeUndefined();
  });
});

describe('isMouseReport', () => {
  it('recognises both halves, so neither is typed into the prompt', () => {
    expect(isMouseReport('[<0;12;5M')).toBe(true);
    expect(isMouseReport('[<0;12;5m')).toBe(true);
    expect(isMouseReport('hello')).toBe(false);
  });
});

describe('trackMouse', () => {
  it('turns reporting on, and off again exactly once', () => {
    const { written, stream } = fakeStdout(true);
    const stop = trackMouse(stream);
    expect(written).toEqual([`${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`]);

    stop();
    stop();
    expect(written).toHaveLength(2);
    expect(written[1]).toBe(`${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l`);
  });

  it('leaves a non-terminal alone', () => {
    const { written, stream } = fakeStdout(false);
    trackMouse(stream)();
    expect(written).toEqual([]);
  });
});
