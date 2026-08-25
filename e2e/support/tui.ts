import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Terminal } from '@xterm/headless';
import { spawn, type IPty } from 'node-pty';
import { framesToAnimatedWebp, frameToWebp, type Frame, type StyledRun } from './render.js';
import { saveAttachment, writeAsset } from './reportStore.js';

const require = createRequire(import.meta.url);
const DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/** node-pty ships its darwin spawn-helper without the exec bit; fix it up front. */
function fixSpawnHelperPermissions(): void {
  try {
    const pkgDir = path.dirname(require.resolve('node-pty/package.json'));
    for (const platform of ['darwin-arm64', 'darwin-x64']) {
      const helper = path.join(pkgDir, 'prebuilds', platform, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch {
    // best effort; spawn will fail loudly if this actually mattered
  }
}

const KEYS = {
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
} as const;
export type KeyName = keyof typeof KEYS;

const SNAPSHOT_DEBOUNCE_MS = 25;
const TYPE_DELAY_MS = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TuiSessionOptions {
  cols?: number;
  rows?: number;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Drives the real built TUI inside a pseudo-terminal, mirrors its output into
 * a headless xterm screen, and records every frame for the e2e report
 * (screenshots + animated-webp video), Playwright-style.
 */
export class TuiSession {
  private pty: IPty;
  private term: Terminal;
  private frames: Frame[] = [];
  private startedAt = Date.now();
  private snapshotTimer: NodeJS.Timeout | undefined;
  private lastFrameKey = '';
  private exited: Promise<number>;
  readonly cols: number;
  readonly rows: number;

  constructor(opts: TuiSessionOptions = {}) {
    this.cols = opts.cols ?? 100;
    this.rows = opts.rows ?? 30;
    fixSpawnHelperPermissions();
    this.term = new Terminal({ cols: this.cols, rows: this.rows, allowProposedApi: true });
    // Ink treats any CI-ish env as "don't render the dynamic UI" — scrub it.
    const env: Record<string, string | undefined> = { ...process.env, TERM: 'xterm-256color', ...opts.env };
    delete env.CI;
    delete env.CONTINUOUS_INTEGRATION;
    this.pty = spawn('node', [DIST, ...(opts.args ?? [])], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: env as Record<string, string>,
    });
    this.exited = new Promise((resolve) => {
      this.pty.onExit(({ exitCode }) => resolve(exitCode));
    });
    this.pty.onData((data) => {
      this.term.write(data, () => this.scheduleSnapshot());
    });
  }

  /** Type text one keystroke at a time (a single chunk would look like a paste to ink). */
  async type(text: string): Promise<void> {
    for (const ch of text) {
      this.pty.write(ch);
      await sleep(TYPE_DELAY_MS);
    }
  }

  async press(key: KeyName): Promise<void> {
    this.pty.write(KEYS[key]);
    await sleep(TYPE_DELAY_MS);
  }

  /** Current screen contents as plain text. */
  screenText(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }

  async waitForText(needle: string | RegExp, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = this.screenText();
      if (typeof needle === 'string' ? text.includes(needle) : needle.test(text)) return;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${String(needle)}. Screen was:\n${this.screenText()}`);
  }

  /** Capture the current screen as a .webp screenshot attached to the report. */
  async screenshot(name: string): Promise<void> {
    await this.flush();
    const frame = this.captureFrame();
    const webp = await frameToWebp(frame, this.cols, this.rows);
    const rel = writeAsset(`${name}.webp`, webp);
    saveAttachment({ kind: 'screenshot', name, path: rel });
  }

  /** Stop the app and finalize the animated-webp video for the report. */
  async close(): Promise<void> {
    await this.flush();
    this.recordFrame(this.captureFrame());
    const finalText = this.screenText();
    this.pty.kill();
    await Promise.race([this.exited, sleep(3000)]);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.frames.length > 0) {
      const { webp, frameCount, durationMs } = await framesToAnimatedWebp(this.frames, this.cols, this.rows);
      const rel = writeAsset('session.webp', webp);
      saveAttachment({ kind: 'video', name: 'session', path: rel, frameCount, durationMs }, finalText);
    }
    this.term.dispose();
  }

  waitForExit(timeoutMs = 5000): Promise<number> {
    return Promise.race([
      this.exited,
      sleep(timeoutMs).then(() => {
        throw new Error('TUI did not exit in time');
      }),
    ]);
  }

  /** Resolve pending terminal writes so the screen model is current. */
  private flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', () => resolve()));
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.recordFrame(this.captureFrame());
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  private recordFrame(frame: Frame): void {
    const key = JSON.stringify(frame.rows);
    if (key === this.lastFrameKey) return;
    this.lastFrameKey = key;
    this.frames.push(frame);
  }

  private captureFrame(): Frame {
    const buffer = this.term.buffer.active;
    const rows: StyledRun[][] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      const runs: StyledRun[] = [];
      if (line) {
        let current: StyledRun | undefined;
        for (let x = 0; x < this.cols; x++) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue; // wide-char continuation
          const ch = cell.getChars() || ' ';
          const style = {
            fg: cell.isFgDefault() ? null : cell.isFgRGB() ? rgbHex(cell.getFgColor()) : cell.getFgColor(),
            bg: cell.isBgDefault() ? null : cell.isBgRGB() ? rgbHex(cell.getBgColor()) : cell.getBgColor(),
            bold: !!cell.isBold(),
            dim: !!cell.isDim(),
            inverse: !!cell.isInverse(),
            underline: !!cell.isUnderline(),
          };
          if (current && sameStyle(current, style)) {
            current.text += ch;
          } else {
            current = { text: ch, ...style };
            runs.push(current);
          }
        }
      }
      // Drop unstyled trailing whitespace to keep frames light.
      while (runs.length > 0) {
        const last = runs[runs.length - 1];
        if (last.text.trim() === '' && last.bg === null && !last.inverse) runs.pop();
        else break;
      }
      rows.push(runs);
    }
    return { t: Date.now() - this.startedAt, rows };
  }
}

function sameStyle(a: StyledRun, b: Omit<StyledRun, 'text'>): boolean {
  return (
    a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim &&
    a.inverse === b.inverse && a.underline === b.underline
  );
}

function rgbHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}
