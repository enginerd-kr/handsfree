import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import type { AuditEntry } from '../policy/types.js';

export type TranscriptBody =
  | { type: 'user'; text: string }
  /**
   * When `stream` is set, this closes the `assistant_delta` records that share
   * it: the text here is the reply's final form, and an empty text retracts the
   * streamed block entirely — the deltas turned out not to be an answer.
   */
  | { type: 'assistant'; text: string; stream?: number }
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
  | { type: 'stop'; taskId: number; agentId: string; sessionId: string; stopReason: StopReason }
  | { type: 'decision'; agentId: string; entry: AuditEntry }
  /**
   * What one call to the orchestration model cost. Characters are counted here
   * and are always present; tokens are the endpoint's own figure and are there
   * only when it gave one. Not shown anywhere — this is the number to read
   * when a run feels expensive, and the file is where to read it.
   */
  | {
      type: 'usage';
      purpose: 'plan' | 'narrate';
      promptChars: number;
      replyChars: number;
      promptTokens?: number;
      completionTokens?: number;
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
  private readonly records: TranscriptRecord[] = [];
  private readonly stream: fs.WriteStream | undefined;

  constructor(file?: string) {
    super();
    this.setMaxListeners(0);
    this.stream = file ? fs.createWriteStream(file, { flags: 'a' }) : undefined;
  }

  append(body: TranscriptBody): TranscriptRecord {
    const record: TranscriptRecord = { ...body, seq: ++this.seq, at: Date.now() };
    this.records.push(record);
    // A write after end would throw; a turn still settling during shutdown may
    // append after close, and losing its record beats crashing on the way out.
    if (!this.closed) this.stream?.write(`${JSON.stringify(record)}\n`);
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

/**
 * Files that are different because of these records: what handsfree itself
 * wrote on the agent's behalf, and what the agent reported editing, moving or
 * deleting. A read is a `touchedFiles` entry and not one of these — the next
 * agent needs to know what changed, not what was looked at.
 */
export function changedFiles(records: readonly TranscriptRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.type === 'decision') {
      const { entry } = record;
      if (entry.verdict === 'allow' && entry.request.kind === 'fs.write') seen.add(entry.request.path);
      continue;
    }
    if (record.type !== 'session_update') continue;
    const update = record.update;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue;
    if (update.kind !== 'edit' && update.kind !== 'delete' && update.kind !== 'move') continue;
    for (const location of update.locations ?? []) {
      if (location?.path) seen.add(location.path);
    }
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
