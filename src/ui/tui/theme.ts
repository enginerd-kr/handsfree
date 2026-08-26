import type { Marker, Tone } from '../view-model.js';

/** Claude's orange. handsfree keeps one accent and spends it on who is speaking. */
export const BRAND = '#d77757';

export const COLOUR: Record<Tone, string | undefined> = {
  normal: undefined,
  muted: 'gray',
  good: 'green',
  bad: 'red',
  warn: 'yellow',
  accent: '#7d8bf5',
  brand: BRAND,
};

// The filled circle lines up properly on macOS terminals and not much else.
const DOT = process.platform === 'darwin' ? '⏺' : '●';

export const GLYPH: Record<Marker, string> = {
  none: ' ',
  prompt: '>',
  bullet: DOT,
  thought: '✻',
  result: '⎿',
  allowed: '✓',
  refused: '✗',
};

/**
 * The wash behind a task left open on screen — dark enough to sit under the
 * text rather than compete with it. A hover brightens it to plain gray.
 */
export const BAND = '#3a3a3a';

/** The gutter that opens a row's continuation lines, and its blank counterpart. */
export const RESULT_GUTTER = '⎿';
export const RESULT_INDENT = ' ';

export const SPINNER = ['·', '✢', '✳', '∗', '✻', '✽'];
