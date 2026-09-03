/**
 * The account an agent closes its turn with, in the shape handsfree asked for.
 *
 * The shape is a block of `key: value` lines under a `REPORT` heading rather
 * than JSON, because that is what a coding CLI reliably writes at the end of a
 * turn: prose-adjacent, unfenced, and readable by a small planner without
 * being decoded first. The parser is lenient on purpose — bold keys, a fenced
 * block, a missing field — and never asks the agent to try again: a retry
 * costs more than the report was ever going to save.
 */
export type ReportOutcome = 'done' | 'partial' | 'blocked';

export interface Report {
  /** What the agent says became of the task. Absent when it did not say. */
  outcome: ReportOutcome | undefined;
  /** One or two sentences; the tail of the message when there was no block. */
  summary: string;
  /** Files the agent says it changed, as it wrote them — relative or not. */
  changed: string[];
  /** Choices the next agent has to know were made, and why. */
  decided: string[];
  /** What the agent could not settle: for the next agent, or for the user. */
  open: string[];
  /** How to check the work — a command, mostly. */
  verify: string;
  /** Whether a REPORT block was found. False means `summary` is a fallback. */
  structured: boolean;
}

export interface ReportLimits {
  /** Longest a summary is kept, whichever way it was obtained. */
  summaryChars: number;
  /** How many `decided` and `open` items are kept, each. */
  items: number;
  /** Longest one item is kept. */
  itemChars: number;
}

export const DEFAULT_REPORT_LIMITS: ReportLimits = { summaryChars: 300, items: 3, itemChars: 160 };

/** How much of a message without a REPORT block stands in for its summary. */
const FALLBACK_TAIL_CHARS = 600;

const KEYS = ['outcome', 'summary', 'changed', 'decided', 'open', 'verify'] as const;
type Key = (typeof KEYS)[number];

/** The heading, as an agent writes it: bare, bolded, as a markdown header, or with a colon. */
const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__|`)?\s*REPORT\s*(?:\*\*|__|`)?\s*:?\s*$/i;
/** A field line. Bold or backticked keys are unwrapped; a leading dash is allowed. */
const FIELD = /^\s*(?:[-*]\s+)?(?:\*\*|__|`)?\s*([a-z]+)\s*(?:\*\*|__|`)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
/** A list item under a field. */
const ITEM = /^\s*[-*•]\s+(.*)$/;
const FENCE = /^\s*```/;

export function parseReport(message: string, limits: ReportLimits = DEFAULT_REPORT_LIMITS): Report {
  const lines = message.split(/\r?\n/);
  let start = -1;
  for (let at = lines.length - 1; at >= 0; at--) {
    if (HEADING.test(lines[at]!)) {
      start = at;
      break;
    }
  }
  if (start === -1) return fallback(message, limits);

  const fields = new Map<Key, string[]>();
  let current: Key | undefined;
  for (const raw of lines.slice(start + 1)) {
    if (FENCE.test(raw)) continue;
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    const field = FIELD.exec(line);
    const key = field ? (field[1]!.toLowerCase() as Key) : undefined;
    if (field && key && KEYS.includes(key)) {
      current = key;
      const value = field[2]!.trim();
      fields.set(key, value === '' ? [] : [value]);
      continue;
    }
    if (!current) continue;
    const item = ITEM.exec(line);
    const list = fields.get(current)!;
    if (item) list.push(item[1]!.trim());
    // A continuation of the last value, for a summary that wrapped.
    else if (list.length > 0) list[list.length - 1] += ` ${line.trim()}`;
    else list.push(line.trim());
  }

  const one = (key: Key) =>
    oneLine((fields.get(key) ?? []).join(' '), Number.MAX_SAFE_INTEGER).replace(/^`+|`+$/g, '');
  const many = (key: Key) =>
    items(fields.get(key) ?? [])
      .slice(0, limits.items)
      .map((entry) => oneLine(entry, limits.itemChars));

  return {
    outcome: outcomeOf(one('outcome')),
    summary: oneLine(one('summary'), limits.summaryChars),
    changed: paths(fields.get('changed') ?? []),
    decided: many('decided'),
    open: many('open'),
    verify: oneLine(one('verify'), limits.itemChars),
    structured: true,
  };
}

function fallback(message: string, limits: ReportLimits): Report {
  const flat = message.replace(/\s+/g, ' ').trim();
  // The end of what was said, since a closing account ends on what became of
  // it — as much of that as a summary may be.
  const keep = Math.min(FALLBACK_TAIL_CHARS, limits.summaryChars);
  const tail = flat.length > keep ? `…${flat.slice(-keep + 1).trimStart()}` : flat;
  return {
    outcome: undefined,
    summary: tail,
    changed: [],
    decided: [],
    open: [],
    verify: '',
    structured: false,
  };
}

function outcomeOf(text: string): ReportOutcome | undefined {
  const word = text.toLowerCase().replace(/[^a-z]/g, ' ').trim().split(/\s+/)[0];
  switch (word) {
    case 'done':
    case 'complete':
    case 'completed':
    case 'success':
      return 'done';
    case 'partial':
    case 'incomplete':
      return 'partial';
    case 'blocked':
    case 'failed':
    case 'stuck':
      return 'blocked';
    default:
      return undefined;
  }
}

/**
 * Items as listed: one per `- ` line, or the field line itself. Not split on
 * punctuation — a semicolon in "not verified; the command was refused" is
 * prose, and an agent that wants two items writes two lines.
 */
function items(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.replace(/^[-*•]\s*/, '').trim();
    if (trimmed !== '' && !/^(none|n\/a|nothing|-)$/i.test(trimmed)) out.push(trimmed);
  }
  return out;
}

function paths(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    for (const part of value.split(/[,\s]+/)) {
      const trimmed = part.replace(/^[`'"]+|[`'".:]+$/g, '');
      if (trimmed === '' || /^(none|n\/a|nothing|-)$/i.test(trimmed)) continue;
      if (!out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The format, as the agent is told it. Kept in one place so the spec the
 * agent reads and the parser that reads the agent never drift apart.
 */
export const REPORT_FORMAT = `End every turn with a REPORT block, in exactly this shape, after everything else you say:
REPORT
outcome: done | partial | blocked
summary: one or two sentences — what changed and what you verified
changed: comma-separated paths you changed, or none
decided: - one line per choice the next person must know about, with the reason
open: - one line per thing you could not settle or verify
verify: the command that checks the work, or how to check it
Keep it short: the summary under 300 characters, at most three items each. Leave a field empty rather than padding it.`;

/** The one-line reminder on every brief after the first. */
export const REPORT_REMINDER = 'End your turn with a REPORT block.';
