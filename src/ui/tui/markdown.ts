import chalk from 'chalk';
import { marked, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { CODE_WASH, COLOUR, INK, INK_FAINT } from './theme.js';

/**
 * Markdown, rendered the way Claude Code renders its own: not into a tree of
 * Ink elements but into a single ANSI-escaped string.
 *
 * That choice is what keeps `layout.ts` honest. Ink wraps text with
 * `wrapAnsi(text, width, {trim: false, hard: true})` and `heightOf` already
 * calls exactly that, so a multi-line ANSI string measures to the row count it
 * actually occupies — mouse hit-testing and the viewport budget keep working
 * without a line of change. Ink 7 passes colour and hyperlink escapes through
 * untouched: its `sanitize-ansi` strips only cursor movement, so nothing here
 * needs the Ink fork Claude Code carries to get this on screen.
 *
 * The one rule a caller must keep: a row drawn from this text carries no Ink
 * colour of its own. Ink would wrap the string in a colour that the first
 * reset inside it would end early.
 */

/**
 * Always a bare newline, never `os.EOL`. A carriage return in the middle of a
 * styled run shifts the text a column right when the terminal wraps it.
 */
const EOL = '\n';

/** Blockquote bar: left one-quarter block. */
const QUOTE_BAR = '▎';

export interface Highlighter {
  highlight: (code: string, options: { language: string }) => string;
  supportsLanguage: (language: string) => boolean;
}

export interface RenderOptions {
  /** Defer highlighting the unfinished block until it settles. */
  streaming?: boolean;
  /** Available text columns, after the transcript gutter and indent. */
  width?: number;
  /** Null until `cli-highlight` has loaded, or for good if it never does. */
  highlight?: Highlighter | null;
  /** Thoughts read as a quieter register: their styling carries the quiet ink. */
  dim?: boolean;
}

interface Context {
  width?: number;
  highlight: Highlighter | null;
  dim: boolean;
}

let configured = false;

/**
 * The one thing `marked` is asked to do differently: stop reading a tilde as
 * strikethrough. A model writing ~100 means "about a hundred" far more often
 * than it means to cross anything out.
 */
function configureMarked(): void {
  if (configured) return;
  configured = true;
  marked.use({ tokenizer: { del: () => undefined } });
}

/**
 * Whether the text carries anything worth lexing. Most replies are a plain
 * sentence, and this spares them the parse entirely. Check the whole message:
 * an answer can introduce a list or code after a long opening paragraph.
 */
const MD_SYNTAX = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdown(text: string): boolean {
  return MD_SYNTAX.test(text);
}

/**
 * The inline-code colour, reusing the accent this UI already spends. Built per
 * call rather than once: `chalk.hex` fixes the colour depth at the moment it is
 * built, and at module load there is not yet a terminal to ask.
 */
function code(text: string): string {
  return chalk.hex(COLOUR.accent ?? '#7d8bf5')(text);
}

function render(tokens: readonly Token[], context: Context): string {
  // Block spacing belongs to the display, even when the source has no blank
  // line after a heading or list. Each settled block owns its separator so
  // streaming and whole-message rendering produce the same layout.
  return tokens.map((token) => {
    if (token.type === 'space') return '';
    const block = formatToken(token, 0, null, null, context).replace(/\n+$/, '');
    return block ? block + EOL + EOL : '';
  }).join('');
}

function children(
  token: Token & { tokens?: Token[] },
  listDepth: number,
  ordered: number | null,
  parent: Token | null,
  context: Context,
): string {
  return (token.tokens ?? [])
    .map((child) => formatToken(child, listDepth, ordered, parent, context))
    .join('');
}

function formatToken(
  token: Token,
  listDepth: number,
  orderedListNumber: number | null,
  parent: Token | null,
  context: Context,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = render(token.tokens ?? [], {
        ...context,
        width: context.width === undefined ? undefined : Math.max(1, context.width - 2),
      }).trimEnd();
      const bar = chalk.hex(INK_FAINT)(QUOTE_BAR);
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line))
        .join(EOL);
    }

    case 'code':
      return codeBlock(token as Tokens.Code, context);

    case 'codespan':
      return code(token.text);

    case 'em':
      return chalk.italic(children(token, 0, null, parent, context));

    case 'strong':
      return chalk.bold(children(token, 0, null, parent, context));

    case 'heading': {
      const text = children(token, 0, null, null, context);
      // Only the top heading earns more than weight; past h2 the depth stops
      // being worth a distinct look in a transcript this narrow.
      const styled = token.depth === 1 ? chalk.bold.italic.underline(text) : chalk.bold(text);
      // The block renderer adds the separation from the following paragraph.
      return styled + EOL;
    }

    case 'hr':
      return `---${EOL}`;

    case 'image':
      return token.href;

    case 'link': {
      // A mailto is an address, not somewhere to click.
      if (token.href.startsWith('mailto:')) return token.href.replace(/^mailto:/, '');
      const text = children(token, 0, null, token, context);
      const plain = stripAnsi(text);
      return link(token.href, plain && plain !== token.href ? text : undefined);
    }

    case 'list':
      return token.items
        .map((item: Token, index: number) =>
          formatToken(item, listDepth, token.ordered ? token.start + index : null, token, context),
        )
        .join('');

    case 'list_item': {
      const marker = orderedListNumber === null ? '-' : `${listNumber(listDepth + 1, orderedListNumber)}.`;
      const indent = ' '.repeat(marker.length + 1);
      const innerContext = {
        ...context,
        width: context.width === undefined ? undefined : Math.max(1, context.width - indent.length),
      };
      const body = (token.tokens ?? []).map((child) => {
        let content = formatToken(child, listDepth + 1, null, token, innerContext);
        if (innerContext.width !== undefined && (child.type === 'text' || child.type === 'paragraph')) {
          content = wrapAnsi(content, innerContext.width, { hard: true, trim: true });
        }
        return child.type === 'text' ? content + EOL : content;
      }).join('').replace(/\n+$/, '');
      return body.split(EOL).map((line, index) =>
        `${index === 0 ? marker + ' ' : indent}${line}`,
      ).join(EOL) + EOL;
    }

    case 'paragraph':
      return children(token, 0, null, null, context) + EOL;

    case 'space':
    case 'br':
      return EOL;

    case 'text': {
      return token.tokens ? children(token, listDepth, orderedListNumber, parent, context) : token.text;
    }

    case 'checkbox':
      return token.checked ? '[x] ' : '[ ] ';

    case 'table':
      return table(token as Tokens.Table, context);

    case 'escape':
      return token.text;

    // Nothing a terminal can show, or — for `del` — a tokenizer we turned off.
    case 'def':
    case 'del':
    case 'html':
      return '';
  }
  return '';
}

/**
 * A fenced block, highlighted when `cli-highlight` is up and left alone when it
 * is not. No border and no indent — a border is a character a copy would
 * carry, and an indent moves code out of the column its lines were written
 * in — but a wash behind it: every line padded out to the block's widest and
 * set on `CODE_WASH`, so the block stands as one rectangle. Prose and code
 * share a column and a weight, and a long reply that is mostly code has no
 * other edge to read by.
 *
 * Wrap before padding so a long source line cannot make every short line
 * spill into another screen row. Layout measures this same rendered string.
 */
function codeBlock(token: Tokens.Code, context: Context): string {
  // Nothing is held back: the transcript scrolls by rows, so a long block costs
  // a scroll rather than the rest of the conversation.
  let out = token.text;

  if (context.highlight) {
    // An info string can carry more than a name (`ts title="x"`); the language
    // is the first word of it.
    const tag = token.lang?.trim().split(/\s+/)[0] ?? '';
    const language = tag && context.highlight.supportsLanguage(tag) ? tag : 'plaintext';
    try {
      out = context.highlight.highlight(out, { language });
    } catch {
      // An unknown language is not worth losing the code over.
    }
  }

  if (context.width !== undefined) {
    out = wrapAnsi(out, context.width, { hard: true, trim: false });
  }
  return wash(out, context.width) + EOL;
}

/**
 * The block's lines on their wash. Each is padded to the widest line, plus one
 * column, so the rectangle's right edge stands a cell clear of the longest
 * line rather than hugging it. Highlighting only ever resets the foreground,
 * so the background it is set on holds to the end of the line.
 */
function wash(text: string, width?: number): string {
  const lines = text.split(EOL);
  const widths = lines.map((line) => stringWidth(stripAnsi(line)));
  const widest = Math.min(Math.max(...widths) + 1, width ?? Infinity);
  const paint = chalk.bgHex(CODE_WASH);
  return lines.map((line, i) => paint(line + ' '.repeat(Math.max(0, widest - widths[i]!)))).join(EOL);
}

/**
 * An OSC 8 hyperlink. The text stays blue rather than taking a theme colour:
 * `wrap-ansi` does not carry an RGB colour across a wrap inside a link.
 */
function link(href: string, text?: string): string {
  return `\u001B]8;;${href}\u0007${chalk.blue(text ?? href)}\u001B]8;;\u0007`;
}

/** Depth decides the shape of an ordered marker: `1.`, then `a.`, then `i.`. */
function listNumber(listDepth: number, n: number): string {
  switch (listDepth) {
    case 2:
      return letter(n);
    case 3:
      return roman(n);
    default:
      return String(n);
  }
}

function letter(n: number): string {
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

function roman(n: number): string {
  let out = '';
  for (const [value, numeral] of ROMAN) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}

/**
 * A pipe table when its columns fit; labeled values when the pane is narrow.
 * Layout measures the resulting string, including any explicit line breaks.
 */
function table(token: Tokens.Table, context: Context): string {
  const cell = (cellTokens: Token[] | undefined): string =>
    (cellTokens ?? []).map((t) => formatToken(t, 0, null, null, context)).join('');

  const widths = token.header.map((header, index) => {
    let width = stringWidth(stripAnsi(cell(header.tokens)));
    for (const row of token.rows) {
      width = Math.max(width, stringWidth(stripAnsi(cell(row[index]?.tokens))));
    }
    return Math.max(width, 3);
  });

  // When columns cannot fit, keep each value with its header. Wrapping a
  // whole pipe row would separate values from the columns they belong to.
  if (context.width !== undefined && widths.reduce((sum, width) => sum + width + 3, 1) > context.width) {
    return token.rows.map((row) => token.header.map((header, index) => {
      const label = chalk.bold(cell(header.tokens));
      const value = cell(row[index]?.tokens);
      return wrapAnsi(`${label}: ${value}`, context.width!, { hard: true, trim: false });
    }).join(EOL)).join(EOL + EOL) + EOL;
  }

  const line = (cells: readonly { tokens?: Token[] }[]): string => {
    const parts = cells.map((source, index) => {
      const content = cell(source.tokens);
      return pad(content, stringWidth(stripAnsi(content)), widths[index]!, token.align?.[index]);
    });
    return `| ${parts.join(' | ')} |${EOL}`;
  };

  const rule = `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|${EOL}`;
  return chalk.bold(line(token.header)) + chalk.hex(INK_FAINT)(rule) + token.rows.map(line).join('') + EOL;
}

function pad(
  content: string,
  width: number,
  target: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, target - width);
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return ' '.repeat(left) + content + ' '.repeat(padding - left);
  }
  if (align === 'right') return ' '.repeat(padding) + content;
  return content + ' '.repeat(padding);
}

/** SGR and OSC sequences only — the shapes anything here ever emits. */
const ANSI = /\u001B\[[0-9;]*m|\u001B\]8;;.*?\u0007/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/* ------------------------------------------------------------------ caching */

interface Entry {
  /** Which options produced this, so a change of them starts over. */
  signature: string;
  /** The raw text whose blocks are settled, and what they rendered to. */
  prefix: string;
  prefixAnsi: string;
  /** The last whole answer, so an unchanged row costs one comparison. */
  text: string;
  result: string;
}

const CACHE_MAX = 500;
const cache = new Map<string, Entry>();

function remember(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Forgets every rendered row. For tests, which reuse keys across cases. */
export function resetMarkdownCache(): void {
  cache.clear();
}

/**
 * The text of one row, as markdown.
 *
 * `key` is the row's identity across renders, and it is what makes streaming
 * affordable. A reply arrives a token at a time and this function is called on
 * every one of them, so it splits the text at the last finished block: what is
 * behind that boundary is already rendered and never lexed again, and only the
 * block still being written is re-read. `marked` treats an unclosed fence as a
 * single token, so a half-written code block simply stays in the unsettled tail
 * rather than confusing the boundary.
 */
export function renderMarkdown(key: string, text: string, options: RenderOptions = {}): string {
  const context: Context = {
    highlight: options.highlight ?? null,
    dim: options.dim === true,
    width: options.width === undefined ? undefined : Math.max(1, Math.floor(options.width)),
  };
  const signature = `${context.dim ? 'd' : ''}|${context.highlight ? 'h' : ''}|${context.width ?? ''}|${options.streaming ? 's' : ''}`;

  if (!hasMarkdown(text)) return context.dim ? chalk.hex(INK)(text) : text;
  configureMarked();

  let entry = cache.get(key);
  if (entry && (entry.signature !== signature || !text.startsWith(entry.prefix))) {
    entry = undefined;
  }
  if (entry && entry.text === text) {
    remember(key, entry);
    return entry.result;
  }

  let prefix = entry?.prefix ?? '';
  let prefixAnsi = entry?.prefixAnsi ?? '';

  const tokens = marked.lexer(text.slice(prefix.length));

  // The last token with anything in it is the block still being written;
  // everything before it will not change again.
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last]!.type === 'space') last--;

  const settled = tokens.slice(0, Math.max(last, 0));
  if (settled.length > 0) {
    prefixAnsi += render(settled, context);
    prefix = text.slice(0, prefix.length + settled.reduce((sum, t) => sum + t.raw.length, 0));
  }

  // Trimmed before it is dimmed: chalk closes the run after the last newline,
  // which would put that newline beyond trim's reach.
  const body = (prefixAnsi + render(tokens.slice(settled.length), options.streaming ? { ...context, highlight: null } : context)).replace(/^\n+|\n+$/g, '');
  const result = context.dim ? chalk.hex(INK)(body) : body;

  remember(key, { signature, prefix, prefixAnsi, text, result });
  return result;
}

/* ------------------------------------------------------- syntax highlighting */

let highlighter: Promise<Highlighter | null> | undefined;

/**
 * `cli-highlight` pulls highlight.js behind it, which is far too much to load
 * before the first frame. It is fetched once, in the background, and code
 * blocks render plain until it lands. If it never does, they stay plain.
 */
export function loadHighlighter(): Promise<Highlighter | null> {
  highlighter ??= import('cli-highlight')
    .then((module) => ({
      highlight: module.highlight,
      supportsLanguage: module.supportsLanguage,
    }))
    .catch(() => null);
  return highlighter;
}
