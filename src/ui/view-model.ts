import path from 'node:path';
import type { TranscriptRecord } from '../workspace/transcript.js';

export type Tone = 'normal' | 'muted' | 'good' | 'bad' | 'warn' | 'accent';

export interface ViewItem {
  key: string;
  /** Who is speaking: the user, handsfree itself, an agent, or the machinery. */
  role: 'user' | 'handsfree' | 'agent' | 'system';
  label: string;
  text: string;
  tone: Tone;
}

/**
 * The transcript rendered for a human. Nothing here reaches for state of its
 * own: the same records replayed later produce the same view, which is why the
 * TUI, `run`, and any test can share this function.
 */
export function buildView(records: readonly TranscriptRecord[], workspaceDir: string): ViewItem[] {
  const items: ViewItem[] = [];
  const byKey = new Map<string, ViewItem>();
  let openAgentMessage: ViewItem | undefined;

  const add = (item: ViewItem): ViewItem => {
    items.push(item);
    byKey.set(item.key, item);
    return item;
  };

  for (const record of records) {
    if (record.type !== 'session_update') openAgentMessage = undefined;

    switch (record.type) {
      case 'user':
        add({ key: `u${record.seq}`, role: 'user', label: 'you', text: record.text, tone: 'normal' });
        break;

      case 'assistant':
        add({
          key: `a${record.seq}`,
          role: 'handsfree',
          label: 'handsfree',
          text: record.text,
          tone: 'normal',
        });
        break;

      case 'delegation':
        add({
          key: `d${record.seq}`,
          role: 'system',
          label: record.agentId,
          text: record.task,
          tone: 'accent',
        });
        break;

      case 'note':
        add({
          key: `n${record.seq}`,
          role: 'system',
          label: 'handsfree',
          text: record.text,
          tone: record.level === 'error' ? 'bad' : record.level === 'warn' ? 'warn' : 'muted',
        });
        break;

      case 'decision': {
        const mark = record.entry.verdict === 'allow' ? 'allowed' : 'refused';
        const why = record.entry.reason ? ` — ${record.entry.reason}` : '';
        add({
          key: `p${record.seq}`,
          role: 'system',
          label: record.agentId,
          text: `${mark}: ${record.entry.summary}${why}`,
          tone: record.entry.verdict === 'allow' ? 'muted' : 'bad',
        });
        break;
      }

      case 'stop':
        add({
          key: `s${record.seq}`,
          role: 'system',
          label: record.agentId,
          text: `turn ended (${record.stopReason})`,
          tone: record.stopReason === 'end_turn' ? 'muted' : 'warn',
        });
        break;

      case 'agent_stderr':
        break; // Kept in the file, not shown: adapters are chatty on stderr.

      case 'session_update': {
        const update = record.update;
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            if (update.content.type !== 'text') break;
            if (openAgentMessage) openAgentMessage.text += update.content.text;
            else {
              openAgentMessage = add({
                key: `m${record.seq}`,
                role: 'agent',
                label: record.agentId,
                text: update.content.text,
                tone: 'normal',
              });
            }
            break;
          }
          case 'tool_call':
          case 'tool_call_update': {
            const key = `t${record.agentId}:${update.toolCallId}`;
            const existing = byKey.get(key);
            const title = update.title ?? existing?.text ?? update.toolCallId;
            const where = (update.locations ?? [])
              .map((location) => relative(location.path, workspaceDir))
              .join(', ');
            const status = update.status ?? 'pending';
            const text = `${title}${where ? ` [${where}]` : ''}`;
            const tone: Tone =
              status === 'failed' ? 'bad' : status === 'completed' ? 'muted' : 'accent';
            if (existing) {
              existing.text = text;
              existing.tone = tone;
            } else {
              add({ key, role: 'agent', label: record.agentId, text, tone });
            }
            openAgentMessage = undefined;
            break;
          }
          default:
            break;
        }
        break;
      }
    }
  }

  return items;
}

/** One-line rendering for non-interactive output. Returns nothing for noise. */
export function describeRecord(record: TranscriptRecord, workspaceDir: string): string | undefined {
  switch (record.type) {
    case 'user':
      return `> ${record.text}`;
    case 'assistant':
      return `\n${record.text}\n`;
    case 'delegation':
      return `→ ${record.agentId}: ${record.task}`;
    case 'note':
      return `  ${record.text}`;
    case 'decision':
      return `  ${record.entry.verdict === 'allow' ? '+' : '-'} ${record.entry.summary}`;
    case 'stop':
      return `← ${record.agentId} (${record.stopReason})`;
    case 'session_update': {
      const update = record.update;
      if (update.sessionUpdate === 'tool_call') {
        const where = (update.locations ?? [])
          .map((location) => relative(location.path, workspaceDir))
          .join(', ');
        return `  · ${update.title}${where ? ` [${where}]` : ''}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function relative(file: string, root: string): string {
  const rel = path.relative(root, file);
  return rel === '' || rel.startsWith('..') ? file : rel;
}
