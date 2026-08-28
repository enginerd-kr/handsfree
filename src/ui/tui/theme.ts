import type { Brief, Marker, Tone } from '../view-model.js';

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

/**
 * The one gray the app sets its quiet text in — every hint, every detail
 * line, every muted row, the header's second line. The terminal's own `gray`
 * is whatever the profile made of ANSI 8, and dimming on top of it lands
 * somewhere darker again, so the two together drifted a long way apart from
 * screen to screen. This is a fixed value instead: quiet against the brand's
 * light, but still plainly readable on a dark ground.
 */
export const INK = '#9b9b9b';

/**
 * The single step under it, and the only one — spent where a gray has to say
 * *less* than the quiet text beside it: a separator between two things, a
 * label for an agent sitting idle, the pointer while a turn runs. Anything
 * that wanted to be quieter still gets this, not a dim on top of a gray.
 */
export const INK_FAINT = '#7a7a7a';

export const COLOUR: Record<Tone, string | undefined> = {
  normal: undefined,
  muted: INK,
  good: 'green',
  bad: 'red',
  warn: 'yellow',
  accent: '#7d8bf5',
  brand: BRAND,
};

// The filled circle lines up properly on macOS terminals and not much else.
const DOT = process.platform === 'darwin' ? '⏺' : '●';

/**
 * The dots under the prompt, one per agent: filled while the agent holds an
 * open task, outlined while it sits idle. The filled one is the transcript's
 * own bullet, so the pair never disagrees with the rest of the frame.
 */
export const DOT_BUSY = DOT;
export const DOT_IDLE = '○';

/**
 * The planner's mark in the same roll: a diamond rather than a dot, filled and
 * outlined the same way. It leads the line and it is the only entry spelled
 * `agent:model`, because it is the only one that is not an agent — what it
 * names is which agent is doing the routing, and on what.
 */
export const PLAN_BUSY = '◆';
export const PLAN_IDLE = '◇';

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
 * text rather than compete with it. A hover lifts it a step.
 */
export const BAND = '#3a3a3a';

/**
 * The wash under the pointer. It used to be the terminal's own `gray`, bright
 * enough that quiet text laid on it had to be recoloured to survive; this is
 * the open task's band lifted just far enough to read as a different row, so
 * the ink above it never has to change.
 */
export const HOVER_BAND = '#4f4f4f';

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
 * The two rules the prompt sits between — the one gray that is not text. They
 * run the whole width, so they read heavier than any text at the same value,
 * and they sit a step under the faint ink for that reason. The rule holds this
 * value whether or not a turn is running: the pointer between the rules is
 * what dims to say so.
 */
export const RULE_INK = '#6a6a6a';

/** The gutter that opens a row's continuation lines, and its blank counterpart. */
export const RESULT_GUTTER = '⎿';
export const RESULT_INDENT = ' ';

/**
 * The startup mark, drawn the way Claude Code draws its condensed logo: three
 * rows of quadrant blocks in the terminal's own ink — the same light the
 * header's name is set in — with the background showing through as the face.
 *
 * The mark is built from parts so it can hold a pose: a head whose eyes are
 * the corner missing from each of ▛ and ▜ — shut, those corners fill in — a
 * body whose outer nubs are arms riding the top or the bottom of their cell,
 * a row of feet, and a row of nothing. Every part keeps the same nine cells,
 * so no pose can shift what sits beside or below the mark; the header's row
 * count is what a click is measured against.
 *
 * The eyes are what say which way the mark is going. A quadrant is the
 * smallest a pair of eyes can move and the largest they can move and still
 * be a face — one quadrant over, both of them, and the mark is plainly
 * looking that way — so the glance is a quadrant either side of straight
 * out: the hole slides across its own cell and the far eye takes the next
 * cell along. The two glances are each other's mirror; straight out is its
 * own.
 */
const HEAD_AHEAD = ' ▐▛███▜▌ ';
const HEAD_LEFT = ' ▐▜██▛█▌ ';
const HEAD_RIGHT = ' ▐█▜██▛▌ ';
const HEAD_SHUT = ' ▐█████▌ ';
const ARMS_UP = '▝▜█████▛▘';
const ARMS_DOWN = '▗▜█████▛▖';
const FEET = '  ▘▘ ▝▝  ';
const AIR = ' '.repeat([...HEAD_AHEAD].length);

/**
 * The stances the mark holds: upright with its arms raised, at ease with
 * them dropped, sat on the ground — the whole mark a row lower, its feet
 * tucked under it — and mid-jump, feet off the bottom row entirely.
 */
export type Stance = 'stand' | 'easy' | 'sit' | 'air';

/** Where the mark is looking: straight out, or a quadrant to one side. */
export type Look = 'ahead' | 'left' | 'right';

const HEAD: Record<Look, string> = {
  ahead: HEAD_AHEAD,
  left: HEAD_LEFT,
  right: HEAD_RIGHT,
};

/**
 * The mark in a stance, eyes open or shut and turned where it is headed —
 * always three rows of nine cells.
 */
export function mascot(
  stance: Stance = 'stand',
  shut = false,
  look: Look = 'ahead',
): readonly [string, string, string] {
  const head = shut ? HEAD_SHUT : HEAD[look];
  switch (stance) {
    case 'easy':
      return [head, ARMS_DOWN, FEET];
    case 'sit':
      return [AIR, head, ARMS_DOWN];
    case 'air':
      return [head, ARMS_UP, AIR];
    default:
      return [head, ARMS_UP, FEET];
  }
}

export const MASCOT = mascot();

/**
 * What the mark says when the mood takes it, with nothing to report: a
 * greeting, a hurry-up, an offer, an idle thought. Every one is kept to four
 * hangul glyphs or their width in Latin — the stage is sized off the widest
 * of them, and a saying that leans into the header's text costs the name and
 * the path beside it their room.
 */
export const SAYINGS = [
  'Hi',
  '허리업',
  '말만해',
  '가보자고',
  '심심해',
  '뭐 할까',
  '준비됐어',
  '한 방에',
  '쉬엄쉬엄',
  '고고씽',
  '천천히',
  '딴짓 중',
  '눈 붙임',
  'zzz',
  'ping!',
  '오케이',
  '커맨드?',
  '스트레칭',
  '물 마셔',
  '갑니다',
] as const;

/**
 * What it says instead while there is a turn to report on: where the work
 * stands, in the same breath a saying takes. The phases are the ones the
 * transcript can tell apart — nothing delegated yet, a task running, the end
 * in sight, and the turn over — and each keeps a handful of wordings so a
 * long run does not repeat itself into a status light.
 */
export const BRIEFINGS: Record<Brief, readonly string[]> = {
  start: ['시작!', '접수!', '출발!', '가봅시다'],
  work: ['작업 중', '진행 중', '열일 중'],
  nearly: ['거의 다', '곧 끝나', '막바지', '마무리!'],
  done: ['다 됐어', '완료!', '끝!', '수고!'],
};

/** Display columns of a piece of text — hangul and its CJK neighbours sit two columns to Latin's one. */
const WIDE = /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿＀-｠￠-￦]/;
export function columns(text: string): number {
  let count = 0;
  for (const char of text) count += WIDE.test(char) ? 2 : 1;
  return count;
}

/**
 * The stage the mark wanders on: its own cells with room on each side for
 * the megaphone's column and the widest thing it says, briefings counted in —
 * a saying goes out
 * whichever side of the mark it fits, and the mark never has to shuffle to
 * make room. The header gives the stage this width outright, so however far
 * the mark roams and whatever it says, the margin before it and the column
 * of text after it never move a cell.
 */
export const MASCOT_STAGE =
  [...MASCOT[0]].length +
  2 * (1 + Math.max(...[...SAYINGS, ...Object.values(BRIEFINGS).flat()].map(columns)));

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
