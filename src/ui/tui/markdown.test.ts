import chalk from 'chalk';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type { ViewItem } from '../view-model.js';
import { heightOf } from './layout.js';
import { renderMarkdown, resetMarkdownCache } from './markdown.js';
import { CODE_WASH, INK } from './theme.js';

/**
 * Nothing under vitest is a terminal, so chalk emits no colour by default and
 * every styling assertion would pass on an empty string. The level is forced
 * once here; the renderer reads it at call time, and Ink reads the very same
 * chalk, so this is the level a real terminal gives it.
 */
beforeAll(() => {
  chalk.level = 3;
});

beforeEach(() => {
  // Keys are reused across cases, and the cache is keyed by them.
  resetMarkdownCache();
});

const BOLD = '\u001B[1m';
const ITALIC = '\u001B[3m';
const UNDERLINE = '\u001B[4m';
const QUIET = chalk.hex(INK)('').split('\u001B[39m')[0];

/** What the row actually reads as, once the styling is taken back off. */
function plain(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m|\u001B\]8;;.*?\u0007/g, '');
}

const md = (text: string, key = 'k') => renderMarkdown(key, text);

describe('markdown', () => {
  it('styles a top heading and drops its hashes', () => {
    const out = md('# Title');
    expect(plain(out)).toBe('Title');
    expect(out).toContain(BOLD);
    expect(out).toContain(ITALIC);
    expect(out).toContain(UNDERLINE);
  });

  it('gives a second-level heading weight but not the rest', () => {
    const out = md('## Section');
    expect(plain(out)).toBe('Section');
    expect(out).toContain(BOLD);
    expect(out).not.toContain(UNDERLINE);
  });

  it('renders bold and italic', () => {
    expect(md('**loud**')).toContain(BOLD);
    expect(md('*quiet*', 'k2')).toContain(ITALIC);
  });

  it('colours inline code and keeps no backticks', () => {
    const out = md('call `heightOf` first');
    expect(plain(out)).toBe('call heightOf first');
    expect(out).not.toContain('`');
    expect(out).toContain('\u001B[38;2;');
  });

  it('marks a bullet list', () => {
    expect(plain(md('- one\n- two'))).toBe('- one\n- two');
  });

  it('numbers an ordered list, and changes shape as it nests', () => {
    const out = plain(md('1. one\n2. two'));
    expect(out).toBe('1. one\n2. two');

    const nested = plain(md('1. one\n   1. inner\n      1. deepest', 'nest'));
    // Depth decides the marker: a number, then a letter, then a roman numeral.
    expect(nested).toContain('1. one');
    expect(nested).toContain('a. inner');
    expect(nested).toContain('i. deepest');
  });

  it('opens each blockquote line with a bar', () => {
    const out = md('> quoted');
    expect(plain(out)).toContain('▎ quoted');
  });

  it('draws a horizontal rule', () => {
    expect(plain(md('---'))).toBe('---');
  });

  it('leaves a tilde alone, because a model means "about"', () => {
    // Strikethrough is off: ~100 is a quantity, not a correction.
    expect(plain(md('it took ~100 ms'))).toBe('it took ~100 ms');
    expect(plain(md('~~struck~~', 'strike'))).toBe('~~struck~~');
  });

  it('passes plain prose straight through', () => {
    const prose = 'Hello there. I read the file and it looks fine.';
    expect(md(prose)).toBe(prose);
  });

  it('separates headings, prose, and lists even without blank source lines', () => {
    expect(plain(md('## Findings\nThe result.\n- first\n- second\n## Next\nContinue.')))
      .toBe('Findings\n\nThe result.\n\n- first\n- second\n\nNext\n\nContinue.');
  });

  it('recognizes markdown after a long plain introduction', () => {
    const out = plain(md('Introduction. '.repeat(50) + '\n\n## Findings\n**done**'));
    expect(out).toContain('Findings\n\ndone');
    expect(out).not.toContain('##');
  });

  it('keeps loose list markers, nested items, and checkbox states', () => {
    const out = plain(md('- **one**\n\n  second paragraph\n  - nested\n- [x] done\n- [ ] pending'));
    expect(out).toContain('- one\n  \n  second paragraph\n  - nested');
    expect(out).toContain('- [x] done');
    expect(out).toContain('- [ ] pending');
    expect(out).not.toContain('**');
  });

  it('hangs wrapped Korean list text under the body, including nested items', () => {
    const out = plain(renderMarkdown('list', '- 한국어 설명을 여러 줄로 표시합니다\n  - 중첩 항목도 정렬합니다', { width: 20 }));
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => stringWidth(line) <= 20)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith('  '))).toBe(true);
    expect(lines).toContain('  - 중첩 항목도');
  });

  it('keeps table values associated with headers after a resize', () => {
    const source = '| Agent | Result |\n| --- | --- |\n| claude | A long result that needs room |\n| codex | Tests passed |';
    expect(plain(renderMarkdown('table', source, { width: 80 }))).toContain('| Agent');
    const narrow = plain(renderMarkdown('table', source, { width: 24 }));
    expect(narrow).toContain('Agent: claude\nResult:');
    expect(narrow).toContain('Agent: codex\nResult: Tests passed');
    expect(narrow.split('\n').every((line) => stringWidth(line) <= 24)).toBe(true);
    expect(plain(renderMarkdown('table', source, { width: 80 }))).toContain('| Agent');
  });

  it('quiets a thought without painting over its styling', () => {
    const out = renderMarkdown('t', '**loud** thought', { dim: true });
    expect(out).toContain(QUIET);
    expect(plain(out)).toBe('loud thought');
  });

  describe('code blocks', () => {
    it('wraps long code before padding short lines to the screen width', () => {
      const out = plain(renderMarkdown('code', '```\n' + 'x'.repeat(55) + '\nshort\n```', { width: 20 }));
      const lines = out.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines.every((line) => stringWidth(line) === 20)).toBe(true);
      expect(lines[3]?.trimEnd()).toBe('short');
    });

    it('preserves leading code indentation with colors disabled', () => {
      const level = chalk.level;
      try {
        chalk.level = 0;
        expect(md('```\n    indented\n```').trimEnd()).toBe('    indented');
      } finally {
        chalk.level = level;
      }
    });
    it('renders a fenced block without its fences', () => {
      const out = plain(md('```ts\nconst a = 1;\n```'));
      expect(out.trimEnd()).toBe('const a = 1;');
      expect(out).not.toContain('```');
    });

    it('survives a fence that has not closed yet', () => {
      // Mid-stream this is the normal case, not an error.
      const out = plain(md('```ts\nconst a = 1;'));
      expect(out).toContain('const a = 1;');
      expect(out).not.toContain('```');
    });

    it('sets every line of a block on one wash, padded out to a rectangle', () => {
      const out = md('```js\nconst a = 1;\n\nconst longer = a + 1;\n```');
      const washOn = chalk.bgHex(CODE_WASH)('').split('\u001B[49m')[0] ?? '';
      const lines = out.split('\n');
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line.startsWith(washOn)).toBe(true);
        expect(line.endsWith('\u001B[49m')).toBe(true);
      }
      // Each line runs to the widest one plus a cell, blank ones included.
      const widths = lines.map((line) => plain(line).length);
      expect(widths).toEqual([22, 22, 22]);
      expect(plain(lines[0]!)).toBe('const a = 1;          ');
    });

    it('measures the rectangle in columns, so a wide glyph is not padded twice', () => {
      const out = md('```\n한글\nabcd\n```');
      const [first, second] = out.split('\n').map(plain);
      // 한글 is four columns wide, the same as abcd; both get the one spare cell.
      expect([first, second]).toEqual(['한글 ', 'abcd ']);
    });

    it('keeps a long block whole', () => {
      const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
      const out = plain(md('```\n' + body + '\n```'));
      expect(out).toContain('line 29');
      expect(out).not.toContain('lines');
    });
  });

  describe('streaming', () => {
    it('keeps spacing and wrapping stable while lists and tables stream', () => {
      const source = '## 결과\n- 한국어로 긴 결과를 설명합니다\n  - **중첩** 항목입니다\n\n| Agent | Result |\n| --- | --- |\n| codex | All tests passed |\n\nDone.';
      const expected = renderMarkdown('whole-width', source, { width: 24 });
      for (let end = 1; end <= source.length; end++) {
        renderMarkdown('stream-width', source.slice(0, end), { width: 24 });
      }
      expect(renderMarkdown('stream-width', source, { width: 24 })).toBe(expected);
    });
    it('lands on the same text whether it arrives at once or a token at a time', () => {
      const answer = [
        '## What I found',
        '',
        'The height math is in `layout.ts`, and it already agrees:',
        '',
        '```ts',
        'const rows = wrapAnsi(text, width).split(EOL).length;',
        '```',
        '',
        'So nothing there needs to move.',
      ].join('\n');

      const atOnce = renderMarkdown('whole', answer);

      // The stable-prefix split only re-reads the block still being written,
      // so the result has to be identical to never having split at all.
      let streamed = '';
      for (const char of answer) {
        streamed += char;
        renderMarkdown('stream', streamed);
      }
      expect(renderMarkdown('stream', answer)).toBe(atOnce);
    });

    it('recovers when the text is replaced rather than extended', () => {
      renderMarkdown('swap', '## first\n\nbody');
      // A retracted reply is not a prefix of what came before it.
      expect(plain(renderMarkdown('swap', '## second\n\nother'))).toContain('second');
    });
  });
});

/**
 * The sharpest risk in the whole change. `heightOf` is what a click's row is
 * measured against and what decides how much of the transcript fits, and it
 * measures `item.text` — which now carries newlines and escape codes.
 */
describe('row heights survive markdown', () => {
  const item = (text: string): ViewItem => ({
    key: 'h',
    role: 'agent',
    depth: 0,
    marker: 'bullet',
    markerTone: 'brand',
    text,
    tone: 'normal',
    lines: [],
    gap: false,
  });

  /** What Ink will actually draw, using the call Ink itself makes. */
  const drawn = (text: string, columns: number): number =>
    wrapAnsi(text, columns - 2, { trim: false, hard: true }).split('\n').length;

  it('counts every line of a multi-line block', () => {
    const text = renderMarkdown('height', '## Title\n\nfirst\n\nsecond');
    expect(text).toContain('\n');
    expect(heightOf(item(text), 80)).toBe(drawn(text, 80));
  });

  it('stays exact once the lines wrap', () => {
    const text = renderMarkdown('wrap', `- ${'word '.repeat(40)}`);
    for (const columns of [20, 40, 80]) {
      expect(heightOf(item(text), columns)).toBe(drawn(text, columns));
    }
  });

  it('stays exact for double-width text', () => {
    const text = renderMarkdown('cjk', `**${'한국어 '.repeat(30)}**`);
    for (const columns of [24, 60]) {
      expect(heightOf(item(text), columns)).toBe(drawn(text, columns));
    }
  });

  it('never emits a carriage return, which would shift a styled run', () => {
    expect(renderMarkdown('cr', '## Title\n\n- one\n- two')).not.toContain('\r');
  });
});
