import { describe, expect, it } from 'vitest';
import { lineAround, lineCount, stepLine } from './draft.js';

describe('lineAround', () => {
  it('spans the whole text when there is no line break', () => {
    expect(lineAround('hello', 2)).toEqual({ start: 0, end: 5 });
  });

  it('stops at the breaks on either side', () => {
    expect(lineAround('one\ntwo\nthree', 5)).toEqual({ start: 4, end: 7 });
  });

  it('puts a cursor sitting on a break at the end of the line before it', () => {
    expect(lineAround('one\ntwo', 3)).toEqual({ start: 0, end: 3 });
  });

  it('counts code points, so an emoji is one column', () => {
    expect(lineAround('🙂a\nb', 2)).toEqual({ start: 0, end: 2 });
  });
});

describe('stepLine', () => {
  it('has nowhere to go in a single line', () => {
    expect(stepLine('hello', 2, 'up')).toBeUndefined();
    expect(stepLine('hello', 2, 'down')).toBeUndefined();
  });

  it('keeps the column when the line there is long enough', () => {
    expect(stepLine('one\ntwo', 5, 'up')).toBe(1);
    expect(stepLine('one\ntwo', 1, 'down')).toBe(5);
  });

  it('falls to the end of a shorter line', () => {
    expect(stepLine('a\nlonger', 8, 'up')).toBe(1);
    expect(stepLine('longer\na', 6, 'down')).toBe(8);
  });

  it('refuses at the top and the bottom, where the key means the history', () => {
    expect(stepLine('one\ntwo', 1, 'up')).toBeUndefined();
    expect(stepLine('one\ntwo', 5, 'down')).toBeUndefined();
  });

  it('steps onto an empty line and off it again', () => {
    expect(stepLine('one\n\ntwo', 2, 'down')).toBe(4);
    expect(stepLine('one\n\ntwo', 4, 'down')).toBe(5);
  });
});

describe('lineCount', () => {
  it('is one for a line without a break, and one more per break', () => {
    expect(lineCount('')).toBe(1);
    expect(lineCount('one')).toBe(1);
    expect(lineCount('one\ntwo\n')).toBe(3);
  });
});
