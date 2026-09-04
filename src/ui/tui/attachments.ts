/**
 * What the prompt holds without showing: a long paste, or an image. Either
 * would swamp a line meant for a sentence, so each is folded to a short
 * placeholder where it was put — `[Pasted text #1 +40 lines]`, `[Image #1]`
 * — and unfolded only in what is sent. The placeholder is ordinary text in
 * the draft: it can be moved through, deleted, and sent in the middle of a
 * sentence like any other word.
 *
 * Attachments are kept for the run rather than for the line: a placeholder
 * recalled from the history still stands for what it stood for.
 */
import { lineCount } from './draft.js';

export type Attachment = { kind: 'text'; text: string } | { kind: 'image'; path: string };

/** One attachment and its number, counted within its kind. */
export interface Attached {
  id: number;
  attachment: Attachment;
}

export type Attachments = readonly Attached[];

export const NOTHING_ATTACHED: Attachments = [];

/** Where a placeholder sits in the draft, in code points, and what it stands for. */
export interface PlaceholderSpan {
  start: number;
  end: number;
  attached: Attached;
}

const LONG_LINES = 3;
const LONG_CHARS = 300;

/** Whether a paste is too long to sit in the line as it is. */
export function isLongPaste(text: string): boolean {
  return lineCount(text) >= LONG_LINES || [...text].length > LONG_CHARS;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/i;

/**
 * The image file a paste names, if that is all it is: a file dragged from
 * the finder lands in the terminal as its path, sometimes quoted or with
 * its spaces escaped. `exists` is asked before the path is believed.
 */
export function imagePathIn(text: string, exists: (path: string) => boolean): string | undefined {
  const line = text.trim();
  if (line === '' || /[\r\n]/.test(line)) return undefined;
  const bare = line
    .replace(/^'(.*)'$/, '$1')
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\ /g, ' ');
  if (!IMAGE_FILE.test(bare)) return undefined;
  return exists(bare) ? bare : undefined;
}

/** The short form an attachment wears in the draft. */
export function placeholder(attached: Attached): string {
  const { id, attachment } = attached;
  return attachment.kind === 'text'
    ? `[Pasted text #${id} +${lineCount(attachment.text)} lines]`
    : `[Image #${id}]`;
}

/** Adds an attachment, numbered after the ones of its kind before it. */
export function attach(
  list: Attachments,
  attachment: Attachment,
): { list: Attachments; placeholder: string } {
  const id = list.filter((entry) => entry.attachment.kind === attachment.kind).length + 1;
  const attached = { id, attachment };
  return { list: [...list, attached], placeholder: placeholder(attached) };
}

const PLACEHOLDER = /\[(?:Pasted text #(\d+) \+\d+ lines|Image #(\d+))\]/g;

/**
 * Every placeholder in `value` that stands for something in `list`. A bracket
 * typed by hand in the same shape, with no attachment behind it, is left as
 * the text it is.
 */
export function placeholderSpans(value: string, list: Attachments): PlaceholderSpan[] {
  const spans: PlaceholderSpan[] = [];
  for (const match of value.matchAll(PLACEHOLDER)) {
    const kind = match[1] !== undefined ? 'text' : 'image';
    const id = Number(match[1] ?? match[2]);
    const attached = list.find((entry) => entry.id === id && entry.attachment.kind === kind);
    if (!attached) continue;
    // The match is measured in UTF-16 units; the draft counts code points.
    const start = [...value.slice(0, match.index)].length;
    spans.push({ start, end: start + [...match[0]].length, attached });
  }
  return spans;
}

/**
 * The draft as it is sent: each placeholder replaced by what it stood for —
 * a paste by its text, an image by its number and path, which is what an
 * agent with a file to open can use.
 */
export function expand(value: string, list: Attachments): string {
  return value.replace(PLACEHOLDER, (whole, textId?: string, imageId?: string) => {
    const kind = textId !== undefined ? 'text' : 'image';
    const id = Number(textId ?? imageId);
    const attached = list.find((entry) => entry.id === id && entry.attachment.kind === kind);
    if (!attached) return whole;
    const { attachment } = attached;
    return attachment.kind === 'text' ? attachment.text : `[Image #${id}: ${attachment.path}]`;
  });
}
