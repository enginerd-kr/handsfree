import sharp from 'sharp';

/** One styled run of text within a terminal row. */
export interface StyledRun {
  text: string;
  /** Palette index (0-255), '#rrggbb', or null for the default color. */
  fg: number | string | null;
  bg: number | string | null;
  bold: boolean;
  dim: boolean;
  inverse: boolean;
  underline: boolean;
}

export interface Frame {
  /** ms since recording started */
  t: number;
  rows: StyledRun[][];
}

/* Tokyo Night-ish terminal theme. */
const DEFAULT_BG = '#1a1b26';
const DEFAULT_FG = '#c0caf5';
const ANSI_16 = [
  '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
  '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
];

function paletteColor(index: number): string {
  if (index < 16) return ANSI_16[index];
  if (index < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const i = index - 16;
    const r = levels[Math.floor(i / 36)];
    const g = levels[Math.floor(i / 6) % 6];
    const b = levels[i % 6];
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  const gray = 8 + 10 * (index - 232);
  return `#${gray.toString(16).padStart(2, '0').repeat(3)}`;
}

function resolve(color: number | string | null, fallback: string): string {
  if (color === null) return fallback;
  if (typeof color === 'string') return color;
  return paletteColor(color);
}

const CELL_W = 8.43;
const CELL_H = 18;
const FONT_SIZE = 14;
const PAD = 14;

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Render one terminal frame to a standalone SVG image. */
export function frameToSvg(frame: Frame, cols: number, rows: number): Buffer {
  const width = Math.round(cols * CELL_W + PAD * 2);
  const height = Math.round(rows * CELL_H + PAD * 2);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" rx="8" fill="${DEFAULT_BG}"/>`,
  ];

  frame.rows.forEach((runs, y) => {
    let col = 0;
    const rowTop = PAD + y * CELL_H;
    for (const run of runs) {
      const runCols = run.text.length;
      let fg = resolve(run.fg, DEFAULT_FG);
      let bg = run.bg === null ? null : resolve(run.bg, DEFAULT_BG);
      if (run.inverse) {
        const newFg = bg ?? DEFAULT_BG;
        bg = fg;
        fg = newFg;
      }
      if (bg !== null && bg !== DEFAULT_BG) {
        parts.push(
          `<rect x="${(PAD + col * CELL_W).toFixed(2)}" y="${rowTop}" width="${(runCols * CELL_W).toFixed(2)}" height="${CELL_H}" fill="${bg}"/>`,
        );
      }
      if (run.text.trim() !== '') {
        const attrs = [
          `x="${(PAD + col * CELL_W).toFixed(2)}"`,
          `y="${(rowTop + CELL_H - 4.5).toFixed(2)}"`,
          `font-family="Menlo, Consolas, monospace"`,
          `font-size="${FONT_SIZE}"`,
          `fill="${fg}"`,
          `textLength="${(runCols * CELL_W).toFixed(2)}"`,
          `lengthAdjust="spacingAndGlyphs"`,
          `xml:space="preserve"`,
        ];
        if (run.bold) attrs.push('font-weight="700"');
        if (run.dim) attrs.push('opacity="0.55"');
        if (run.underline) attrs.push('text-decoration="underline"');
        parts.push(`<text ${attrs.join(' ')}>${escapeXml(run.text)}</text>`);
      }
      col += runCols;
    }
  });

  parts.push('</svg>');
  return Buffer.from(parts.join(''));
}

export async function frameToWebp(frame: Frame, cols: number, rows: number): Promise<Buffer> {
  return sharp(frameToSvg(frame, cols, rows)).webp({ quality: 92 }).toBuffer();
}

const MAX_VIDEO_FRAMES = 150;
const LAST_FRAME_HOLD_MS = 1500;

/** Encode the recorded frames as an animated (looping) WebP "video". */
export async function framesToAnimatedWebp(
  frames: Frame[],
  cols: number,
  rows: number,
): Promise<{ webp: Buffer; frameCount: number; durationMs: number }> {
  const kept = frames.slice();
  if (kept.length === 1) kept.push({ ...kept[0], t: kept[0].t + LAST_FRAME_HOLD_MS });
  const delays = kept.map((f, i) =>
    Math.min(3000, Math.max(60, (i + 1 < kept.length ? kept[i + 1].t - f.t : LAST_FRAME_HOLD_MS))),
  );
  // Cap frame count by merging the shortest-lived frames into their predecessor.
  while (kept.length > MAX_VIDEO_FRAMES) {
    let minIdx = 1;
    for (let i = 2; i < kept.length; i++) if (delays[i] < delays[minIdx]) minIdx = i;
    delays[minIdx - 1] += delays[minIdx];
    kept.splice(minIdx, 1);
    delays.splice(minIdx, 1);
  }
  const svgs = kept.map((f) => frameToSvg(f, cols, rows));
  const webp = await sharp(svgs, { join: { animated: true } })
    .webp({ quality: 85, effort: 4, loop: 0, delay: delays })
    .toBuffer();
  return { webp, frameCount: kept.length, durationMs: delays.reduce((a, b) => a + b, 0) };
}
