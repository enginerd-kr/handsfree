import { afterEach, describe, expect, it } from 'vitest';
import { harness, scriptedModel, type Harness } from './harness.js';
import { fakeAgent } from './fake-agent.js';
import type { ChatClient, ChatMessage } from '../src/models/client.js';
import type { LoopReview } from '../src/contracts/review.js';

const opened: Harness[] = [];
afterEach(async () => { for (const h of opened.splice(0).reverse()) await h.dispose(); });
const answer = (message: string) => JSON.stringify({ action: 'answer', message });
const call = (tool: string, input: unknown) => JSON.stringify({ action: 'call', tool, input });
const delegate = (agent: string, prompt: string) => call('agent', { agent, prompt, kind: 'answer' });
const replies = (h: Harness) => h.runtime.transcript.all().filter((r) => r.type === 'assistant').map((r) => r.text);
const source = (messages: ChatMessage[]) => /CURRENT REQUEST SOURCE: (record:\d+)/.exec(messages.find((m) => m.pinned)?.content ?? '')?.[1];

describe('analyze, execute, review loop', () => {
  it('records orchestrator reviews without completing their items after worker execution', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'Compatibility reviewed.' }] });
    const gemini = fakeAgent({ script: () => [{ do: 'say', text: 'Verification items prepared.' }] });
    const review: LoopReview = { objective: 'Review compatibility, then prepare verification.', constraints: ['Preserve --legacy.'],
      completed: [], remaining: ['Review compatibility', 'Prepare verification'], next: 0, blocker: '' };
    const checked = (state: typeof review, action: string) => JSON.stringify({ review: state, ...JSON.parse(action) });
    const llm = scriptedModel([
      checked(review, delegate('claude', 'Review compatibility. Preserve --legacy.')),
      checked({ ...review, completed: ['Compatibility reviewed'], remaining: ['Prepare verification'], next: 0 }, delegate('gemini', 'Prepare verification. Preserve --legacy.')),
      checked({ ...review, completed: ['Compatibility reviewed', 'Verification prepared'], remaining: [], next: -1 }, answer('Both steps are complete.')),
    ]);
    const h = harness({ agents: { claude, gemini }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Review compatibility and prepare verification. Preserve --legacy.');
    expect(claude.prompts[0]).toContain('Preserve --legacy.');
    expect(gemini.prompts[0]).toContain('Preserve --legacy.');
    const stateAfterWorker = llm.seen[1]?.find((message) => message.pinned)?.content ?? '';
    expect(stateAfterWorker).toContain('"completed":[]');
    expect(stateAfterWorker).toContain('"remaining":["Review compatibility","Prepare verification"]');
    const checkpoints = h.runtime.transcript.all().filter((r) => r.type === 'context' && r.entry.event === 'review');
    expect(checkpoints).toHaveLength(3);
    expect(h.runtime.transcript.all().filter((r) => r.type === 'context' && r.entry.event === 'complete')).toHaveLength(0);
    expect(replies(h).at(-1)).toBe('Both steps are complete.');
  });

  it('lets the orchestrator work without any workers configured', async () => {
    const h = harness({ agents: {}, llm: scriptedModel([answer('The answer is 4.')]) });
    opened.push(h);
    await h.runtime.conversation.send('What is 2 + 2?');
    expect(replies(h)).toEqual(['The answer is 4.']);
  });

  it('allows another worker call for the same review item when the orchestrator asks for it', async () => {
    const worker = fakeAgent({ script: () => [{ do: 'say', text: 'Reviewed.' }] });
    const review = { objective: 'Review twice', constraints: [], completed: [], remaining: ['Review'], next: 0, blocker: '' };
    const action = JSON.stringify({ review, action: 'call', tool: 'agent', input: { agent: 'claude', prompt: 'Review.', kind: 'answer' } });
    const llm = scriptedModel([action, action, JSON.stringify({ review: { ...review, completed: ['Review'], remaining: [], next: -1 }, action: 'answer', message: 'Reviewed twice.' })]);
    const h = harness({ agents: { claude: worker }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Review twice.');
    expect(worker.prompts).toHaveLength(2);
    expect(llm.seen[2]?.at(-1)?.content).toContain('Task 2');
    expect(replies(h).at(-1)).toBe('Reviewed twice.');
  });

  it('does its own intermediate work, preserves constraints in briefs, and reviews a failed worker before choosing another', async () => {
    const failed = fakeAgent({ script: () => [{ do: 'fail', message: 'adapter failed' }] });
    const healthy = fakeAgent({ script: () => [{ do: 'say', text: 'The existing flag stays compatible.' }] });
    const seen: ChatMessage[][] = [];
    const llm: ChatClient = { async chat(messages) {
      seen.push([...messages]);
      switch (seen.length) {
        case 1: return call('context', { operation: 'save', key: 'compatibility', kind: 'constraint', text: 'Keep --legacy compatible.', sources: [source(messages)] });
        case 2: return delegate('failed', 'Review flag compatibility. Keep --legacy compatible.');
        case 3: return call('context', { operation: 'save', key: 'review', kind: 'finding', text: 'The first review failed; another worker is needed.', sources: [source(messages)] });
        case 4: return delegate('healthy', 'Review flag compatibility. Keep --legacy compatible.');
        default: return answer('The replacement review confirmed compatibility.');
      }
    } };
    const h = harness({ agents: { failed, healthy }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Review the flag. Keep --legacy compatible.');
    expect(failed.prompts).toHaveLength(1);
    expect(healthy.prompts).toHaveLength(1);
    expect(healthy.prompts[0]).toContain('Keep --legacy compatible.');
    expect(seen[2]?.at(-1)?.content).toContain('error');
    expect(seen[3]?.find((m) => m.pinned)?.content).toContain('The first review failed; another worker is needed.');
    expect(seen.at(-1)?.length).toBe(10);
    expect(replies(h).at(-1)).toBe('The replacement review confirmed compatibility.');
    expect(h.runtime.transcript.all().filter((r) => r.type === 'context' && r.entry.event === 'step')).toHaveLength(5);
  });

  it('can delegate again and read earlier results', async () => {
    const worker = fakeAgent({ script: () => [{ do: 'say', text: 'Detailed finding: the legacy flag remains supported.' }] });
    const llm = scriptedModel([
      delegate('claude', 'Review the flag.'),
      delegate('claude', 'Run an extra review.'),
      call('task_result', { taskId: 'task:1' }),
      answer('Both reviews say the flag is supported.'),
    ]);
    const h = harness({ agents: { claude: worker }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Review the flag and explain it.');
    expect(worker.prompts).toHaveLength(2);
    expect(llm.seen[2]?.at(-1)?.content).toContain('Task 2');
    expect(llm.seen[3]?.at(-1)?.content).toContain('Detailed finding:');
    expect(replies(h).at(-1)).toContain('Both reviews');
  });

  it('recovers when the planner confuses a result record number with its taskId without rerunning the worker', async () => {
    const detail = 'README detail: project configuration overrides the global configuration.';
    const worker = fakeAgent({ script: () => [{ do: 'say', text: `${detail}\nREPORT\noutcome: done\nsummary: README summarized.\nchanged: none\nopen:` }] });
    const review: LoopReview = { objective: 'Summarize README', constraints: [], completed: [], remaining: ['Read README', 'Retrieve summary'], next: 0, blocker: '' };
    const checked = (state: typeof review, action: string) => JSON.stringify({ review: state, ...JSON.parse(action) });
    const retrieval = { ...review, completed: ['Read README'], remaining: ['Retrieve summary'] };
    const seen: ChatMessage[][] = [];
    let recordId = 0;
    const llm: ChatClient = { async chat(messages) {
      seen.push([...messages]);
      switch (seen.length) {
        case 1: return checked(review, delegate('claude', 'Read README.'));
        case 2: {
          recordId = h.runtime.transcript.all().find((r) => r.type === 'task_result')!.seq;
          return checked(retrieval, call('task_result', { taskId: `task:${recordId}` }));
        }
        case 3: return checked(retrieval, call('task_result', { taskId: 'task:1' }));
        default: return answer(detail);
      }
    } };
    const h = harness({ agents: { claude: worker }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Summarize README.');

    expect(recordId).toBeGreaterThan(1);
    expect(seen).toHaveLength(4);
    expect(seen[1]?.find((m) => m.pinned)?.content).toContain(`task:1 (transcript record:${recordId})`);
    expect(seen[2]?.at(-1)?.content).toContain(`record:${recordId} refers to task:1`);
    expect(seen[2]?.at(-1)?.content).toContain('taskId:"task:1"');
    expect(seen[2]?.find((m) => m.pinned)?.content).toContain('"remaining":["Retrieve summary"]');
    expect(seen[3]?.at(-1)?.content).toContain(detail);
    expect(worker.prompts).toHaveLength(1);
    expect(replies(h).at(-1)).toBe(detail);
    const entries = h.runtime.transcript.all().filter((r) => r.type === 'context').map((r) => r.entry);
    const evidence = entries.filter((e) => e.event === 'evidence');
    expect(evidence.some((entry) => entry.text.includes('invalid_task_reference'))).toBe(true);
    expect(evidence.find((entry) => entry.text.includes('"observed_tasks":["task:1"]'))?.text).toContain(detail);
    expect(entries.at(-1)).toMatchObject({ event: 'finish', status: 'reported' });
  });

  it.each(['note', 'review'])('restores constraints from a %s and conversation from disk after restart', async (mode) => {
    let calls = 0;
    const first = harness({ agents: {}, llm: { async chat(messages) {
      if (mode === 'review') return JSON.stringify({ review: { objective: 'Respond in Korean', constraints: ['Respond in Korean.'], completed: [], remaining: [], next: -1, blocker: '' }, action: 'answer', message: '앞으로 한국어로 답하겠습니다.' });
      if (++calls === 1) return call('context', { operation: 'save', key: 'format', kind: 'constraint', text: 'Respond in Korean.', sources: [source(messages)] });
      return answer('앞으로 한국어로 답하겠습니다.');
    } } });
    opened.push(first);
    await first.runtime.conversation.send('앞으로 한국어로 답해줘.');
    await first.runtime.close();

    const llm = scriptedModel([answer('네, 이전 요청을 기억합니다.')]);
    const resumed = harness({ agents: {}, llm, resume: { root: first.root, runId: first.runtime.workspace.id } });
    opened.push(resumed);
    await resumed.runtime.conversation.send('기억하지?');
    expect(llm.seen[0]?.some((m) => m.content === '앞으로 한국어로 답해줘.')).toBe(true);
    expect(llm.seen[0]?.at(-1)?.content).toContain('Respond in Korean.');
    expect(replies(resumed).at(-1)).toBe('네, 이전 요청을 기억합니다.');
  });

  it('reviews workers without a token budget admission check', async () => {
    const worker = fakeAgent({ script: () => [] });
    const llm = scriptedModel([delegate('claude', 'Review the code.'), answer('The worker completed the review.')]);
    const h = harness({ agents: { claude: worker }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Review the code.');
    expect(worker.prompts).toHaveLength(1);
    expect(llm.seen).toHaveLength(2);
    expect(llm.seen[1]?.at(-1)?.content).toContain('done');
    expect(replies(h).at(-1)).toBe('The worker completed the review.');
  });
});
