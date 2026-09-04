import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { SessionUpdate, StopReason, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';
import type { AuditEntry } from '../policy/types.js';
import type { TurnUsage } from '../host/session.js';

export type TranscriptBody =
  | { type: 'user'; text: string }
  /**
   * When `stream` is set, this closes the `assistant_delta` records that share
   * it: the text here is the reply's final form, and an empty text retracts the
   * streamed block entirely — the deltas turned out not to be an answer.
   */
  | {
      type: 'assistant';
      text: string;
      stream?: number;
      /**
       * The reply is the ledger of the turn's tasks rather than handsfree's
       * own prose — the planner could not be reached, or did not report the
       * work. Each line of it is about one agent's task, and the view says so.
       */
      ledger?: boolean;
    }
  /** A piece of handsfree's own reply, shown while the model is still writing. */
  | { type: 'assistant_delta'; stream: number; text: string }
  /**
   * A remark from the machinery. `lines` is for the ones that have more to say
   * than a row — a command's output, a list — and are shown under it rather
   * than crammed into the headline.
   */
  | { type: 'note'; level: 'info' | 'warn' | 'error'; text: string; lines?: string[] }
  /**
   * The line `/clear` drew under everything before it. What is above stays in
   * the file — a run's account of itself is not something a command gets to
   * rewrite — and what starts over is the view: whatever a reader has already
   * dealt with leaves the screen, and only what happens after this is drawn.
   */
  | { type: 'clear' }
  | { type: 'agent_stderr'; agentId: string; text: string }
  /**
   * An agent's session opened for this run: fresh, or picked up from a
   * previous process. Not a row of the conversation — the header carries it —
   * but on the record, since which session a task ran in is what the ledger
   * reads a resumed run against.
   */
  | { type: 'session'; agentId: string; sessionId: string; how: 'new' | 'resumed' }
  /**
   * `model` is the id the session was switched to for this task, when one was
   * asked for — the id and nothing beside it, since the id is what went on the
   * wire and what the record has to be able to be read back against.
   */
  | {
      type: 'delegation';
      taskId: number;
      agentId: string;
      sessionId: string;
      task: string;
      model?: string;
    }
  | { type: 'session_update'; agentId: string; sessionId: string; update: SessionUpdate }
  /**
   * `usage` is what the turn cost as the agent counted it, where the agent
   * counted at all: claude and codex do, in the prompt response; gemini in a
   * corner of its own. Absent, the turn still cost something, and the record
   * says only that nobody said how much.
   */
  | {
      type: 'stop';
      taskId: number;
      agentId: string;
      sessionId: string;
      stopReason: StopReason;
      usage?: TurnUsage;
      /** The model the session was on when the turn ended, where the agent said. */
      model?: string;
    }
  | { type: 'decision'; agentId: string; entry: AuditEntry }
  /**
   * What one exchange cost. For the orchestration model (`plan`, `narrate`)
   * characters are counted here and are always present; tokens are the
   * endpoint's own figure and are there only when it gave one. For a `task`
   * the prompt is the brief the agent was sent, the reply is everything it said,
   * and `relayedChars` is how much of that the planner was then handed — the
   * gap between the last two is what the report contract saves. `/cost` adds
   * these up; the file is where to read them one by one. `model` is the
   * planner as the roll call spells it at the time of the call — the model
   * behind it moves mid-run, and the spend has to stay with the one that
   * spent it.
   */
  | {
      type: 'usage';
      purpose: 'plan' | 'narrate' | 'task';
      model?: string;
      promptChars: number;
      replyChars: number;
      promptTokens?: number;
      completionTokens?: number;
      taskId?: number;
      relayedChars?: number;
    };

export type TranscriptRecord = TranscriptBody & { seq: number; at: number };

interface TranscriptEvents {
  record: [TranscriptRecord];
}

/**
 * The single source of truth for a run. The TUI renders it, the narrator reads
 * it, the audit trail is in it, and tests replay it — so nothing else in the
 * system keeps its own copy of what happened.
 */
export class Transcript extends EventEmitter<TranscriptEvents> {
  private seq = 0;
  private closed = false;
  /** Whether the file ends mid-line, so the first write has to open a new one. */
  private openLine = false;
  private readonly records: TranscriptRecord[] = [];
  private readonly stream: fs.WriteStream | undefined;

  /**
   * Opens the record, and reads back what is already in it. A run reused with
   * `--run <id>` resumes its agents' sessions, and a ledger that started
   * empty beside them would brief every agent as though nothing had happened
   * — the tasks before the restart are on the file, so they are read off it
   * first, and the sequence carries on from where the last process left it.
   * Nothing replayed is announced or rewritten: the listeners are not on yet,
   * and the file already has these lines.
   */
  constructor(file?: string) {
    super();
    this.setMaxListeners(0);
    if (file) this.replay(file);
    this.stream = file ? fs.createWriteStream(file, { flags: 'a' }) : undefined;
  }

  private replay(file: string): void {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    this.openLine = text.length > 0 && !text.endsWith('\n');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        // A line cut short by a process that died mid-write. What came
        // before it is whole, and what comes after it starts a fresh line.
        continue;
      }
      if (!isRecord(record)) continue;
      this.records.push(upgraded(record));
      if (record.seq > this.seq) this.seq = record.seq;
    }
  }

  append(body: TranscriptBody): TranscriptRecord {
    const record: TranscriptRecord = { ...body, seq: ++this.seq, at: Date.now() };
    this.records.push(record);
    // A write after end would throw; a turn still settling during shutdown may
    // append after close, and losing its record beats crashing on the way out.
    if (!this.closed) {
      this.stream?.write(`${this.openLine ? '\n' : ''}${JSON.stringify(record)}\n`);
      this.openLine = false;
    }
    this.emit('record', record);
    return record;
  }

  all(): readonly TranscriptRecord[] {
    return this.records;
  }

  since(seq: number): TranscriptRecord[] {
    return this.records.filter((record) => record.seq > seq);
  }

  /** Records belonging to one delegated task, from its start to its stop. */
  forTask(taskId: number): TranscriptRecord[] {
    const start = this.records.findIndex(
      (record) => record.type === 'delegation' && record.taskId === taskId,
    );
    if (start === -1) return [];
    const rest = this.records.slice(start);
    const end = rest.findIndex((record) => record.type === 'stop' && record.taskId === taskId);
    return end === -1 ? rest : rest.slice(0, end + 1);
  }

  async close(): Promise<void> {
    const stream = this.stream;
    if (!stream || this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}

/** How a ledger reply opens: the head `renderOutcomeHead` writes for a task. */
const LEGACY_LEDGER = /^Task \d+ \(\S+\): /;
/** What a resumed session was written down as before it had a record of its own. */
const LEGACY_RESUMED = /^resumed (\S+) session (\S+)$/;

/**
 * A record read back in the shape it was written, or in the shape it would
 * be written today. A run recorded before sessions had a record of their own
 * said "resumed claude session …" as a note, and read back as a note it sits
 * in the conversation like something claude was asked; read back as what it
 * was, it goes where the header can say it.
 */
function upgraded(record: TranscriptRecord): TranscriptRecord {
  // A ledger reply from before ledgers were marked: it opens on a task head.
  if (record.type === 'assistant' && record.ledger === undefined && LEGACY_LEDGER.test(record.text)) {
    return { ...record, ledger: true };
  }
  if (record.type !== 'note' || record.level !== 'info' || record.lines) return record;
  const legacy = LEGACY_RESUMED.exec(record.text);
  if (!legacy) return record;
  return {
    type: 'session',
    agentId: legacy[1]!,
    sessionId: legacy[2]!,
    how: 'resumed',
    seq: record.seq,
    at: record.at,
  };
}

function isRecord(value: unknown): value is TranscriptRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown; seq?: unknown; at?: unknown };
  return typeof record.type === 'string' && typeof record.seq === 'number' && typeof record.at === 'number';
}

/** Plain text of an agent message, assembled from its streamed chunks. */
export function agentText(records: readonly TranscriptRecord[]): string {
  let text = '';
  for (const record of records) {
    if (record.type !== 'session_update') continue;
    const update = record.update;
    if (update.sessionUpdate !== 'agent_message_chunk') continue;
    if (update.content.type === 'text') text += update.content.text;
  }
  return text.trim();
}

/** What a tool call has said about itself so far, across all of its updates. */
interface ToolCallState {
  kind: ToolKind | undefined;
  status: ToolCallStatus | undefined;
  paths: string[];
}

/**
 * Files that are different because of these records: what handsfree itself
 * wrote on the agent's behalf, and what the agent reported editing, moving or
 * deleting. A read is a `touchedFiles` entry and not one of these — the next
 * agent needs to know what changed, not what was looked at.
 *
 * A tool call is assembled from every record that carries its id, because
 * every field of a `tool_call_update` but the id is optional: the usual shape
 * is an opening `tool_call` that names the kind and an update that names the
 * paths, and reading either alone finds a call with no kind or a kind with no
 * paths. A call that ended in `failed` is left out — an edit that did not
 * happen is not a file the next agent has to re-read, and telling it otherwise
 * is worse than telling it nothing.
 */
export function changedFiles(records: readonly TranscriptRecord[]): string[] {
  const calls = new Map<string, ToolCallState>();
  const written: string[] = [];
  for (const record of records) {
    if (record.type === 'decision') {
      const { entry } = record;
      if (entry.verdict === 'allow' && entry.request.kind === 'fs.write') written.push(entry.request.path);
      continue;
    }
    if (record.type !== 'session_update') continue;
    const update = record.update;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue;
    const state = calls.get(update.toolCallId) ?? { kind: undefined, status: undefined, paths: [] };
    if (update.kind) state.kind = update.kind;
    if (update.status) state.status = update.status;
    for (const location of update.locations ?? []) {
      if (location?.path && !state.paths.includes(location.path)) state.paths.push(location.path);
    }
    calls.set(update.toolCallId, state);
  }

  const seen = new Set<string>(written);
  for (const state of calls.values()) {
    if (state.kind !== 'edit' && state.kind !== 'delete' && state.kind !== 'move') continue;
    if (state.status === 'failed') continue;
    for (const path of state.paths) seen.add(path);
  }
  return [...seen];
}

/** Files an agent reported touching, in the order they were first mentioned. */
export function touchedFiles(records: readonly TranscriptRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.type !== 'session_update') continue;
    const update = record.update;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue;
    for (const location of update.locations ?? []) {
      if (location?.path) seen.add(location.path);
    }
  }
  return [...seen];
}
