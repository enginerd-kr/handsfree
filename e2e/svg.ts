/**
 * A drawn frame, turned into a picture of a terminal.
 *
 * The frames the TUI writes are text and SGR escapes, which is everything a
 * terminal needs and nothing a README can show. This turns one into an SVG:
 * the same characters on the same grid, wearing the same colours, in a window
 * with a title bar — so what the docs show is what the program drew, not a
 * transcription of it.
 */

const ESC = String.fromCharCode(27);
/** SGR is the only escape a frame carries that means anything here. */
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');
/** Everything else ink emits — cursor moves, screen clears — is not paint. */
const OTHER = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}[()][A-Za-z0-9]`, 'g');

/** Hangul and its CJK neighbours take two cells to Latin's one. */
const WIDE = /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const width = (text: string): number => {
  let cells = 0;
  for (const char of text) cells += WIDE.test(char) ? 2 : 1;
  return cells;
};

/**
 * The 16 ANSI slots, in a dark terminal's usual clothes. The app spends real
 * hex on nearly everything it draws, so these are only reached by the few
 * tones named by word — `green`, `red`, `yellow`.
 */
const PALETTE = [
  '#3b4048', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c6cad2',
  '#5c6370', '#ef8a94', '#b5df9b', '#f0d3a0', '#8ac6f5', '#d99ae8', '#7fd4de', '#eceff4',
];

/** The window the frame is drawn in, and the ink it defaults to. */
const CHROME = '#1c1e22';
const BORDER = '#2c2f36';
const SCREEN = '#141619';
const DEFAULT_FG = '#e4e6ea';

const CELL_W = 8.4;
const LINE_H = 19;
const FONT_SIZE = 14;
const BASELINE = 14;
const PAD_X = 18;
const PAD_Y = 14;
const TITLE_H = 30;

interface Style {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  inverse: boolean;
}

const blank = (): Style => ({ bold: false, dim: false, inverse: false });

/** One run of characters that share every attribute, and where it starts. */
interface Run {
  column: number;
  text: string;
  style: Style;
}

function colour(codes: number[], at: number): { value: string | undefined; next: number } {
  const kind = codes[at + 1];
  if (kind === 5) {
    const index = codes[at + 2] ?? 0;
    return { value: indexed(index), next: at + 3 };
  }
  if (kind === 2) {
    const [r, g, b] = [codes[at + 2] ?? 0, codes[at + 3] ?? 0, codes[at + 4] ?? 0];
    return { value: `rgb(${r},${g},${b})`, next: at + 5 };
  }
  return { value: undefined, next: at + 1 };
}

/** The 256-colour cube, for the rare escape that reaches for it. */
function indexed(index: number): string {
  if (index < 16) return PALETTE[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const step = [0, 95, 135, 175, 215, 255];
  const n = index - 16;
  return `rgb(${step[Math.floor(n / 36) % 6]},${step[Math.floor(n / 6) % 6]},${step[n % 6]})`;
}

function apply(style: Style, codes: number[]): Style {
  const next = { ...style };
  for (let at = 0; at < codes.length; at++) {
    const code = codes[at]!;
    if (code === 0) {
      Object.assign(next, blank());
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 27) next.inverse = false;
    else if (code === 39) delete next.fg;
    else if (code === 49) delete next.bg;
    else if (code >= 30 && code <= 37) next.fg = PALETTE[code - 30];
    else if (code >= 90 && code <= 97) next.fg = PALETTE[code - 90 + 8];
    else if (code >= 40 && code <= 47) next.bg = PALETTE[code - 40];
    else if (code >= 100 && code <= 107) next.bg = PALETTE[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const { value, next: after } = colour(codes, at);
      if (code === 38) next.fg = value;
      else next.bg = value;
      at = after - 1;
    }
  }
  return next;
}

/** A frame split into lines of styled runs. */
function parse(frame: string): Run[][] {
  const lines: Run[][] = [];
  let style = blank();
  for (const raw of frame.replace(/\r/g, '').split('\n')) {
    const runs: Run[] = [];
    let column = 0;
    let at = 0;
    SGR.lastIndex = 0;
    for (let match = SGR.exec(raw); ; match = SGR.exec(raw)) {
      const upto = match ? match.index : raw.length;
      const text = raw.slice(at, upto).replace(OTHER, '');
      if (text) {
        runs.push({ column, text, style });
        column += width(text);
      }
      if (!match) break;
      style = apply(style, (match[1] ?? '').split(';').map((code) => Number(code) || 0));
      at = SGR.lastIndex;
    }
    lines.push(runs);
  }
  return lines;
}

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface ShotOptions {
  /** Columns the frame was drawn at — the picture's grid. */
  columns: number;
  /** What the window's title bar says. */
  title?: string;
}

/**
 * The frame as an SVG terminal window.
 *
 * Every run is placed at its own column and given an explicit `textLength`, so
 * the grid holds whatever monospace font the reader's machine falls back to —
 * a picture whose columns drift is a picture of nothing.
 */
export function toSvg(frame: string, { columns, title = 'handsfree' }: ShotOptions): string {
  const lines = parse(frame);
  const rows = lines.length;
  const w = Math.round(PAD_X * 2 + columns * CELL_W);
  const h = Math.round(TITLE_H + PAD_Y * 2 + rows * LINE_H);

  const rects: string[] = [];
  const texts: string[] = [];
  lines.forEach((runs, row) => {
    const y = TITLE_H + PAD_Y + row * LINE_H;
    for (const run of runs) {
      const style = run.style;
      const fg = style.inverse ? (style.bg ?? SCREEN) : (style.fg ?? DEFAULT_FG);
      const bg = style.inverse ? (style.fg ?? DEFAULT_FG) : style.bg;
      const x = PAD_X + run.column * CELL_W;
      const cells = width(run.text);
      if (bg) {
        rects.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cells * CELL_W).toFixed(1)}" height="${LINE_H}" fill="${bg}"/>`,
        );
      }
      if (run.text.trim() === '') continue;
      const weight = style.bold ? ' font-weight="600"' : '';
      const opacity = style.dim ? ' opacity="0.6"' : '';
      texts.push(
        `<text x="${x.toFixed(1)}" y="${(y + BASELINE).toFixed(1)}" fill="${fg}"${weight}${opacity}` +
          ` textLength="${(cells * CELL_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` +
          ` xml:space="preserve">${escapeText(run.text)}</text>`,
      );
    }
  });

  const lights = ['#ff5f57', '#febc2e', '#28c840']
    .map((fill, index) => `<circle cx="${20 + index * 17}" cy="${TITLE_H / 2}" r="5.5" fill="${fill}"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}">
<rect width="${w}" height="${h}" rx="10" fill="${CHROME}" stroke="${BORDER}"/>
<rect x="1" y="${TITLE_H}" width="${w - 2}" height="${h - TITLE_H - 1}" fill="${SCREEN}"/>
${lights}
<text x="${w / 2}" y="${TITLE_H / 2 + 4}" fill="#8b8f98" font-size="12" text-anchor="middle">${escapeText(title)}</text>
${rects.join('\n')}
${texts.join('\n')}
</svg>
`;
}
