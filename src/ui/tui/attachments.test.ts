import { describe, expect, it } from 'vitest';
import {
  NOTHING_ATTACHED,
  attach,
  expand,
  imagePathIn,
  isLongPaste,
  placeholderSpans,
} from './attachments.js';

describe('isLongPaste', () => {
  it('lets a short line through', () => {
    expect(isLongPaste('hello')).toBe(false);
    expect(isLongPaste('one\ntwo')).toBe(false);
  });

  it('folds three lines, or one long one', () => {
    expect(isLongPaste('one\ntwo\nthree')).toBe(true);
    expect(isLongPaste('x'.repeat(301))).toBe(true);
  });
});

describe('imagePathIn', () => {
  const exists = (path: string) => path === '/pics/a b.png';

  it('takes a bare path, a quoted one, and one with its spaces escaped', () => {
    expect(imagePathIn('/pics/a b.png\n', exists)).toBe('/pics/a b.png');
    expect(imagePathIn("'/pics/a b.png'", exists)).toBe('/pics/a b.png');
    expect(imagePathIn('/pics/a\\ b.png', exists)).toBe('/pics/a b.png');
  });

  it('refuses what is not an image file that exists', () => {
    expect(imagePathIn('/pics/missing.png', exists)).toBeUndefined();
    expect(imagePathIn('/pics/a b.txt', () => true)).toBeUndefined();
    expect(imagePathIn('/pics/a.png\n/pics/b.png', () => true)).toBeUndefined();
  });
});

describe('attach', () => {
  it('numbers each kind on its own', () => {
    const first = attach(NOTHING_ATTACHED, { kind: 'text', text: 'a\nb\nc' });
    const second = attach(first.list, { kind: 'image', path: '/p.png' });
    const third = attach(second.list, { kind: 'text', text: 'd' });
    expect(first.placeholder).toBe('[Pasted text #1 +3 lines]');
    expect(second.placeholder).toBe('[Image #1]');
    expect(third.placeholder).toBe('[Pasted text #2 +1 lines]');
  });
});

describe('placeholderSpans', () => {
  it('finds a placeholder in code points, and ignores one nothing stands behind', () => {
    const { list, placeholder } = attach(NOTHING_ATTACHED, { kind: 'image', path: '/p.png' });
    const value = `🙂 ${placeholder} and [Image #2]`;
    expect(placeholderSpans(value, list)).toEqual([
      { start: 2, end: 2 + [...placeholder].length, attached: list[0] },
    ]);
  });
});

describe('expand', () => {
  it('puts the paste back and names the image by its path', () => {
    const one = attach(NOTHING_ATTACHED, { kind: 'text', text: 'a\nb\nc' });
    const two = attach(one.list, { kind: 'image', path: '/p.png' });
    const value = `see ${one.placeholder} and ${two.placeholder}`;
    expect(expand(value, two.list)).toBe('see a\nb\nc and [Image #1: /p.png]');
  });

  it('leaves a placeholder alone that stands for nothing', () => {
    expect(expand('[Image #3]', NOTHING_ATTACHED)).toBe('[Image #3]');
  });
});
