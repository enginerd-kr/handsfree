import fs from 'node:fs';
import type { Transcript } from '../../workspace/transcript.js';
import type { TaskOutcome } from '../results/outcome.js';
import { floorOf } from './ledger.js';

function version(file: string): string {
  try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; }
  catch { return 'missing'; }
}

export function remember(transcript: Transcript, outcome: TaskOutcome, sessionId: string): void {
  transcript.append({ type: 'memory', agentId: outcome.agentId, sessionId,
    topic: outcome.task,
    files: [...new Set([...outcome.files, ...outcome.changed])].map((file) => ({ path: file, version: version(file) })) });
}

export function sessionMemory(transcript: Transcript, agentId: string, sessionId?: string) {
  const records = transcript.all();
  const floor = floorOf(records);
  const files = new Map<string, string>();
  const topics: string[] = [];
  const memories = records.filter((record) => record.seq > floor && record.type === 'memory' && record.agentId === agentId);
  const latest = memories.at(-1);
  const live = sessionId ?? (latest?.type === 'memory' ? latest.sessionId : undefined);
  let previousUsed = 0;
  let compactedAt = floor;
  for (const record of records) {
    if (record.type !== 'session_update' || record.agentId !== agentId || record.sessionId !== live || record.update.sessionUpdate !== 'usage_update') continue;
    if (previousUsed > 0 && record.update.used < previousUsed * 0.7) compactedAt = record.seq;
    previousUsed = record.update.used;
  }
  for (const record of memories) {
    if (record.type !== 'memory' || record.sessionId !== live || record.seq <= compactedAt) continue;
    for (const file of record.files) files.set(file.path, file.version);
    topics.push(record.topic);
  }
  const fresh: string[] = [], stale: string[] = [];
  for (const [file, stamp] of files) (version(file) === stamp ? fresh : stale).push(file);
  const usage = records.findLast((record) => record.type === 'session_update' && record.agentId === agentId
    && (live === undefined || record.sessionId === live) && record.update.sessionUpdate === 'usage_update');
  const context = usage?.type === 'session_update' && usage.update.sessionUpdate === 'usage_update'
    ? { used: usage.update.used, size: usage.update.size } : undefined;
  return { fresh, stale, topics, sessionId: live, context };
}
