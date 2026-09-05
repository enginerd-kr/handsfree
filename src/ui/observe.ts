import type { Transcript, TranscriptRecord } from '../workspace/transcript.js';
import { spendOf, type RunSpend } from '../orchestrator/usage/usage.js';
import { createView, sessionsOf, turnPhase, workingAgents, type TurnPhase, type ViewItem, type ViewOptions } from './view-model.js';

export interface ViewUpdate {
  items: ViewItem[];
  working?: ReadonlySet<string>;
  phase?: TurnPhase;
  sessions?: Record<string, 'new' | 'resumed'>;
  spend?: RunSpend;
}

/** Batch text at most one frame apart; control events and completed replies flush immediately. */
export function observeView(transcript: Transcript, dir: string, options: ViewOptions,
  update: (view: ViewUpdate) => void, clear: () => void = () => {}) {
  const view = createView(dir, options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let working = true, phase = true, sessions = true, spend = true;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const records = transcript.all();
    update({ items: view.snapshot(),
      ...(working ? { working: workingAgents(records) } : {}),
      ...(phase ? { phase: turnPhase(records) } : {}),
      ...(sessions ? { sessions: sessionsOf(records) } : {}),
      ...(spend ? { spend: spendOf(records) } : {}),
    });
    working = phase = sessions = spend = false;
  };
  for (const record of transcript.all()) view.push(record);
  flush();
  const arrived = (record: TranscriptRecord) => {
    view.push(record);
    const sessionUpdate = record.type === 'session_update' ? record.update.sessionUpdate : undefined;
    working ||= record.type === 'delegation' || record.type === 'stop';
    phase ||= working || record.type === 'user' || sessionUpdate === 'plan' || sessionUpdate === 'plan_update';
    sessions ||= record.type === 'session';
    spend ||= record.type === 'usage' || record.type === 'stop' || sessionUpdate === 'usage_update';
    if (record.type === 'clear') clear();
    if (record.type === 'assistant_delta' || sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'agent_thought_chunk') {
      timer ??= setTimeout(flush, 24);
    } else if (working || phase || sessions || spend || ['clear', 'assistant', 'note', 'decision', 'session_update'].includes(record.type)) {
      flush();
    }
  };
  transcript.on('record', arrived);
  return () => { clearTimeout(timer); transcript.off('record', arrived); };
}
