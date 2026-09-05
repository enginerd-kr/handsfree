import { performance } from 'node:perf_hooks';
import { buildView, createView, workingAgents, turnPhase, sessionsOf } from '../src/ui/view-model.js';
import { spendOf } from '../src/orchestrator/usage/usage.js';
import { renderMarkdown, resetMarkdownCache } from '../src/ui/tui/markdown.js';
import { HeightIndex, textWidth } from '../src/ui/tui/layout.js';
import { Transcript } from '../src/workspace/transcript.js';

function fixture(tasks: number) {
  const t = new Transcript();
  for (let taskId = 1; taskId <= tasks; taskId++) {
    t.append({ type: 'user', text: `Review task ${taskId}` });
    t.append({ type: 'delegation', taskId, agentId: 'worker', sessionId: 's', task: `Review task ${taskId}`, kind: 'answer' });
    for (let i = 0; i < 100; i++) t.append({ type: 'session_update', agentId: 'worker', sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '검토 결과 **성능 개선**이 필요합니다. The request can reuse the existing state.\n\n' } } });
    t.append({ type: 'stop', taskId, agentId: 'worker', sessionId: 's', stopReason: 'end_turn', status: 'done' });
  }
  return t;
}
function sample(fn: () => unknown, n = 20) {
  for (let i = 0; i < 5; i++) fn();
  const times = [];
  for (let i = 0; i < n; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); }
  times.sort((a,b) => a-b);
  return { median: +times[Math.floor(n/2)]!.toFixed(2), p95: +times[Math.ceil(n*.95)-1]!.toFixed(2) };
}
// CPU-only fixture: no provider, processes, React, or terminal I/O.
for (const tasks of [10, 50, 100]) {
  const transcript = fixture(tasks);
  const records = transcript.all();
  const historyRecords = records.length;
  resetMarkdownCache();
  function selectors() {
    const items = buildView(records, '/workspace');
    workingAgents(records); turnPhase(records); sessionsOf(records); spendOf(records);
    return items;
  }
  const projection = createView('/workspace');
  for (const record of records) projection.push(record);
  const rendered = new WeakMap<ReturnType<typeof buildView>[number], ReturnType<typeof buildView>[number]>();
  const heights = new HeightIndex();
  const frame = (items: ReturnType<typeof buildView>) => {
    const drawn = items.map(item => {
      if (!item.prose) return item;
      const hit = rendered.get(item);
      if (hit) return hit;
      const next = { ...item, text: renderMarkdown(item.key, item.text, { width: textWidth(item, 100), highlight: null }) };
      rendered.set(item, next);
      return next;
    });
    return heights.total(drawn, 100);
  };
  const full = sample(() => frame(selectors()));
  const incremental = sample(() => {
    projection.push(transcript.append({ type: 'assistant_delta', stream: 999, text: 'more ' }));
    return frame(projection.snapshot());
  });
  console.log(JSON.stringify({ tasks, historyRecords, fullRebuildMs: full, incrementalMs: incremental,
    medianSpeedup: +(full.median / incremental.median).toFixed(1) }));
}
