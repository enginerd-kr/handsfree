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

/**
 * The startup mark, drawn the way Claude Code draws its condensed logo: three
 * rows of quadrant blocks in the brand colour, with the terminal's own
 * background showing through as the face.
 */
export const MASCOT = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '] as const;

/**
 * The prompt's own glyph, the way Claude Code opens its input line. Windows
 * consoles have no reliable glyph for it, so they get the shell's own mark.
 */
export const PROMPT_CHAR = process.platform === 'win32' ? '>' : '❯';

/**
 * The spinner runs its frames out and back again rather than snapping from the
 * widest star to the smallest dot — the bounce is what makes it read as one
 * mark growing, which is how Claude Code's spins.
 */
const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'];
export const SPINNER = [...SPINNER_FRAMES, ...[...SPINNER_FRAMES].reverse()];
