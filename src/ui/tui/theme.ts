import type { Marker, Tone } from '../view-model.js';

/** A bright gray. handsfree keeps one accent and spends it on who is speaking. */
export const BRAND = '#d9d9d9';

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
  // The user's line is marked by its wash now, not by a glyph — no gutter at
  // all, so the text starts in the column the other rows' marks do.
  prompt: '',
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
 * The wash behind the user's own lines: a faint lift of white, a step above
 * the task band, running the whole width of the pane — so what was asked
 * reads as its own strip before anything done about it is read.
 */
export const PROMPT_BAND = '#454545';

/**
 * The wash behind the cells a drag has picked up. Blue where the task band is
 * gray, because the two answer different questions: the band says what belongs
 * together, the selection says what is about to be copied. It goes under the
 * characters as a background of its own, so each keeps its colour — inverse
 * video over highlighted code turns every foreground into a different stripe.
 */
export const SELECTION = '#264f78';

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
 * rows of quadrant blocks in the terminal's own ink — the same light the
 * header's name is set in — with the background showing through as the face.
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
 * What the mark says when the mood takes it: a greeting, a hurry-up, an
 * offer. Kept short — a saying has to sit beside the mark without leaning
 * into the header's text.
 */
export const SAYINGS = ['Hi', '허리업', '말만해'] as const;

/** Display columns of a piece of text — hangul and its CJK neighbours sit two columns to Latin's one. */
const WIDE = /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿＀-｠￠-￦]/;
export function columns(text: string): number {
  let count = 0;
  for (const char of text) count += WIDE.test(char) ? 2 : 1;
  return count;
}

/**
 * The stage the mark wanders on: its own cells with room on each side for
 * the megaphone's column and the widest thing it says — a saying goes out
 * whichever side of the mark it fits, and the mark never has to shuffle to
 * make room. The header gives the stage this width outright, so however far
 * the mark roams and whatever it says, the margin before it and the column
 * of text after it never move a cell.
 */
export const MASCOT_STAGE =
  [...MASCOT[0]].length + 2 * (1 + Math.max(...SAYINGS.map((saying) => columns(saying))));

/**
 * The mark standing `x` columns from the left edge of its stage — negative
 * is offstage, clipped at the edge. A saying sits on the middle row on
 * whichever side it is thrown, behind a megaphone's flare: the column
 * between mark and word carries a slash above and below, opening toward the
 * word. Rows come back ragged; the stage's fixed width is what keeps the
 * neighbours still.
 */
export function stage(
  lines: readonly string[],
  x: number,
  say?: string,
  side: 'left' | 'right' = 'right',
): string[] {
  const rows = lines.map((line) =>
    x < 0 ? [...line].slice(Math.min(-x, [...line].length)).join('') : ' '.repeat(x) + line,
  );
  if (!say) return rows;
  if (side === 'right') {
    return [`${rows[0] ?? ''}/`, `${rows[1] ?? ''} ${say}`, `${rows[2] ?? ''}\\`];
  }
  const edge = ' '.repeat(Math.max(0, x - 1));
  return [
    `${edge}\\${lines[0] ?? ''}`,
    `${' '.repeat(Math.max(0, x - 1 - columns(say)))}${say} ${lines[1] ?? ''}`,
    `${edge}/${lines[2] ?? ''}`,
  ];
}

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
 * The shimmer's own ink: the brand gray lifted to white. The band that
 * crosses the working line has to read as light passing over the word rather
 * than as a second colour, so it is the same gray and not a new one.
 */
export const SHIMMER = '#ffffff';

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
