import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import type { AuditEntry } from '../policy/types.js';

export type TranscriptBody =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'note'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'agent_stderr'; agentId: string; text: string }
  | { type: 'delegation'; taskId: number; agentId: string; sessionId: string; task: string }
  | { type: 'session_update'; agentId: string; sessionId: string; update: SessionUpdate }
  | { type: 'stop'; taskId: number; agentId: string; sessionId: string; stopReason: StopReason }
  | { type: 'decision'; agentId: string; entry: AuditEntry };

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
    this.stream?.write(`${JSON.stringify(record)}\n`);
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
    if (!stream) return;
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
