import fs from 'node:fs';
import path from 'node:path';
import type { Transcript } from '../workspace/transcript.js';
import type { TaskOutcome } from './outcome.js';
import { floorOf, tasksSince, type LedgerTask } from './ledger.js';

function version(file: string): string {
  try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; }
  catch { return 'missing'; }
}

export function remember(transcript: Transcript, outcome: TaskOutcome, sessionId: string): void {
  transcript.append({ type: 'memory', agentId: outcome.agentId, sessionId,
    topic: outcome.task.slice(0, 300),
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
  return { fresh, stale, topics: topics.slice(-3), sessionId: live, context };
}

export function relevance(task: LedgerTask, query: string, root: string): number {
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []);
  const text = `${task.outcome.task} ${task.outcome.report.summary}`.toLowerCase();
  let score = task.outcome.status !== 'done' ? 10 : 0;
  for (const word of words) if (text.includes(word)) score++;
  for (const file of [...task.outcome.files, ...task.outcome.changed]) {
    if (query.includes(path.relative(root, file)) || query.includes(path.basename(file))) score += 5;
  }
  return score;
}

/** Durable decisions remain addressable even after the recent-task window is evicted. */
export function durableFacts(transcript: Transcript, root: string, query: string, maxChars = 1200): string {
  const tasks = tasksSince(transcript.all(), floorOf(transcript.all()), { workspaceDir: root });
  const resolved = new Set(transcript.all().flatMap((record) => record.type === 'resolved' ? record.taskIds : []));
  const candidates = tasks.filter((t) => !resolved.has(t.outcome.taskId) && (t.outcome.report.decided.length || t.outcome.report.open.length))
    .sort((a, b) => relevance(b, query, root) - relevance(a, query, root) || b.seq - a.seq);
  const lines: string[] = [];
  for (const { outcome } of candidates) {
    for (const fact of [...outcome.report.decided.map((s) => `decision: ${s}`), ...outcome.report.open.map((s) => `open: ${s}`)]) {
      const line = `task ${outcome.taskId}: ${fact}`;
      if (lines.join('\n').length + line.length + 1 <= maxChars && !lines.some((s) => s.endsWith(fact))) lines.push(line);
    }
  }
  return lines.length ? `Relevant recorded decisions and open items (historical; check whether resolved):\n${lines.join('\n')}` : '';
}
