import type { Marker, Tone } from '../view-model.js';

/** Claude's orange. handsfree keeps one accent and spends it on who is speaking. */
export const BRAND = '#d77757';

/**
 * Each agent in the colour of whoever makes it, so a delegated block says
 * whose work it is before its name is read: Anthropic's orange, OpenAI's
 * green, Google's blue. The keys are matched loosely because an id is
 * whatever the config called the agent — `claude-code`, `gemini-cli`, and
 * plain `codex` all land on the same colour.
 */
export const AGENT_COLOUR: Record<string, string> = {
  claude: '#d97757',
  // Each maker's own colour taken down to the weight Claude's orange already
  // carries: OpenAI's green and Google's blue are both far more saturated at
  // full strength, and beside a warm coral they read as two signal lights
  // rather than three names. Google's dark-surface blue is the tinted one it
  // publishes itself; the green is the same move made by hand.
  codex: '#6fc2a8',
  gemini: '#8ab4f8',
};

/**
 * The colour a delegated block wears. An agent handsfree has no colour for
 * keeps the house accent rather than going uncoloured — the point of the
 * colour is to mark the row as somebody's, not to name the vendor.
 */
export function agentColour(agentId: string): string {
  const id = agentId.toLowerCase();
  for (const [name, colour] of Object.entries(AGENT_COLOUR)) {
    if (id.includes(name)) return colour;
  }
  return BRAND;
}

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

/**
 * The welcome mark's second ink. The terminal's own `gray` sits too far under
 * the mascot and the agent names to belong with them — this is the header's
 * quiet text, still quiet but in the same light as what it sits beside.
 */
export const HEADER_INK = '#9b9b9b';

/**
 * The two rules the prompt sits between. They run the whole width, so they
 * read heavier than any text at the same value — this is a step under the
 * header's ink for that reason, and it is the same line whether or not a turn
 * is running; only its dimming says which.
 */
export const RULE_INK = '#6a6a6a';

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
 * The same mark with its eyes shut: the two small holes the top row carries —
 * the corner missing from each of ▛ and ▜ — filled in. Only that row changes
 * and it keeps the same nine cells, so a blink can never shift what sits
 * beside or below the mark; the header's row count is what a click is
 * measured against.
 */
export const MASCOT_BLINK = [' ▐█████▌ ', MASCOT[1], MASCOT[2]] as const;

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

/**
 * The shimmer's own ink: the brand orange lifted a few steps. The band that
 * crosses the working line has to read as light passing over the word rather
 * than as a second colour, so it is the same orange and not a new one.
 */
export const SHIMMER = '#f59575';

/**
 * How long the band sits on one column, and how many columns of nothing it
 * travels through between passes. The gap is what makes it a glint instead of
 * a barber's pole — most of a cycle is the word sitting still in one piece.
 */
export const SHIMMER_STEP_MS = 150;
const SHIMMER_GAP = 20;

/**
 * A word split into the part ahead of the shimmer band, the columns under it,
 * and the part behind. The band sweeps right to left, the way Claude Code's
 * does, starting half a gap past the right edge and running to half a gap past
 * the left one.
 *
 * Columns are counted in code points: the line this drives is Latin, and a
 * band landing one cell off on a wide glyph is not worth a width table.
 */
export function shimmer(
  text: string,
  tick: number,
): { before: string; band: string; after: string } {
  const chars = [...text];
  const centre = chars.length + SHIMMER_GAP / 2 - (tick % (chars.length + SHIMMER_GAP));
  const first = centre - 1;
  const last = centre + 1;
  if (first >= chars.length || last < 0) return { before: text, band: '', after: '' };
  const start = Math.max(0, first);
  return {
    before: chars.slice(0, start).join(''),
    band: chars.slice(start, last + 1).join(''),
    after: chars.slice(last + 1).join(''),
  };
}
