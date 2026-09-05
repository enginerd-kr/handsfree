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

const KEYS = ['outcome', 'summary', 'changed', 'decided', 'open', 'verify'] as const;
type Key = (typeof KEYS)[number];

/** The heading, as an agent writes it: bare, bolded, as a markdown header, or with a colon. */
const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__|`)?\s*REPORT\s*(?:\*\*|__|`)?\s*:?\s*$/i;
/** A field line. Bold or backticked keys are unwrapped; a leading dash is allowed. */
const FIELD = /^\s*(?:[-*]\s+)?(?:\*\*|__|`)?\s*([a-z]+)\s*(?:\*\*|__|`)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
/** A list item under a field. */
const ITEM = /^\s*[-*•]\s+(.*)$/;
const FENCE = /^\s*```/;

export function parseReport(message: string): Report {
  const lines = message.split(/\r?\n/);
  const start = lines.findLastIndex((line) => HEADING.test(line));
  if (start === -1) return fallback(message);

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
    oneLine((fields.get(key) ?? []).join(' ')).replace(/^`+|`+$/g, '');
  const many = (key: Key) =>
    items(fields.get(key) ?? [])
      .map((entry) => oneLine(entry));

  return {
    outcome: outcomeOf(one('outcome')),
    summary: one('summary'),
    changed: paths(fields.get('changed') ?? []),
    decided: many('decided'),
    open: many('open'),
    verify: one('verify'),
    structured: true,
  };
}

/**
 * What the agent said with its REPORT block taken off the end — the words
 * meant for the person, without the account meant for the planner. The block
 * is found the way `parseReport` finds it, so what is stripped from the screen
 * is exactly what was read from the record.
 */
export function stripReport(message: string): string {
  const lines = message.split(/\r?\n/);
  const start = lines.findLastIndex((line) => HEADING.test(line));
  if (start === -1) return message;
  // A fence opened just above the heading closes below it; it goes too.
  const from = start > 0 && FENCE.test(lines[start - 1]!) ? start - 1 : start;
  return lines.slice(0, from).join('\n').trimEnd();
}

function fallback(message: string): Report {
  return {
    outcome: undefined,
    summary: oneLine(message),
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

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
Include every relevant decision and open item. Leave a field empty rather than padding it.`;

/** The one-line reminder on every brief after the first. */
export const REPORT_REMINDER = 'End your turn with a REPORT block.';
