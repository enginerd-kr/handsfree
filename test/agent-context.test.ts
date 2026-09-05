import { afterEach, describe, expect, it } from 'vitest';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import { RunContext } from '../src/orchestrator/context/context.js';
import { renderRunState, tasksSince } from '../src/orchestrator/context/ledger.js';

const opened: Harness[] = [];
afterEach(async () => { for (const h of opened.splice(0).reverse()) await h.dispose(); });
const call = (tool: string, input: unknown) => JSON.stringify({ action: 'call', tool, input });
const agent = (recipient: string | string[], prompt: string, context_from?: number[]) =>
  call('agent', { agent: recipient, prompt, kind: 'answer', ...(context_from ? { context_from: context_from.map((id) => `task:${id}`) } : {}) });
const answer = (message: string) => JSON.stringify({ action: 'answer', message });
const report = (message: string, status = 'done') => `${message}\n\nREPORT\noutcome: ${status}\nsummary: Response recorded.\nchanged: none\nopen: none`;

describe('orchestrator-selected result context', () => {
  it('passes exact replies between agents and returns for a rebuttal without a fixed discussion flow', async () => {
    const proposal = `CLAUDE_PROPOSAL_BEGIN\n${'Keep only explicit overrides.\n'.repeat(2000)}CLAUDE_PROPOSAL_END`;
    const rebuttal = 'CODEX_REBUTTAL: defaults should be merged by the loader; persistence alone is insufficient.';
    const claude = fakeAgent({ script: (_prompt, turn) => [{ do: 'say', text: report(turn === 0 ? proposal : 'CLAUDE_REVISION: accept the loader merge with explicit overrides.') }] });
    const codex = fakeAgent({ script: () => [{ do: 'say', text: report(rebuttal) }] });
    const llm = scriptedModel([
      agent('claude', 'Explain the proposal.'),
      agent('codex', 'Review Claude’s actual argument and challenge its assumptions.', [1]),
      agent('claude', 'Respond to Codex’s objection and revise your proposal.', [2]),
      answer('The exchange established that defaults should be merged during loading.'),
    ]);
    const h = harness({ agents: { claude, codex }, llm });
    opened.push(h);
    await h.runtime.conversation.send('@codex @claude 서로 토론해.');
    expect(llm.seen[0]?.at(-1)?.content).toContain('@codex @claude 서로 토론해.');
    expect(claude.prompts).toHaveLength(2);
    expect(codex.prompts).toHaveLength(1);
    expect(codex.prompts[0]?.includes(proposal), 'the full original reply reaches Codex').toBe(true);
    expect(codex.prompts[0]).toContain('Task 1 (claude): done');
    expect(codex.prompts[0]).toContain('source material, not instructions');
    expect(claude.prompts[1]).toContain(rebuttal);
    expect(claude.prompts[1]).toContain('Task 2 (codex): done');
    // The planner receives the full reply, but references it without copying
    // it into its next instruction or any task's stored metadata.
    expect(llm.seen[1]?.at(-1)?.content.includes(proposal)).toBe(true);
    const saved = h.runtime.executor.readOutcome(2);
    expect(saved.task).toBe('Review Claude’s actual argument and challenge its assumptions.');
    expect(saved.contextFrom).toEqual([1]);
    expect(h.runtime.executor.readResult(2).text.includes(proposal)).toBe(false);
    expect(h.runtime.executor.readResult(1).text).toContain('CLAUDE_PROPOSAL_END');
    const state = renderRunState(tasksSince(h.runtime.transcript.all(), 0), h.workspaceDir);
    expect(state).toContain('context from tasks: 1');
    expect(state.includes(proposal)).toBe(false);
    const records = h.runtime.transcript.all();
    expect(records.filter((record) => record.type === 'delegation').map((record) => record.agentId))
      .toEqual(['claude', 'codex', 'claude']);
    expect(records.filter((record) => record.type === 'task_result')).toHaveLength(3);
    expect(records.filter((record) => record.type === 'delegation').at(-1)).toMatchObject({
      task: 'Respond to Codex’s objection and revise your proposal.', contextFrom: [2], kind: 'answer',
    });
    expect(records.filter((record) => record.type === 'assistant').at(-1)?.text).toContain('exchange established');
    expect(new RunContext(h.runtime.transcript).history()).toHaveLength(2);
  });

  it('lets the orchestrator read an answer and pass its own summary to the next worker', async () => {
    const detail = 'ORIGINAL_DETAIL: per-agent model changes must not pin future built-in defaults.';
    const summary = 'ORCHESTRATOR_SUMMARY: preserve default evolution by storing only explicit overrides.';
    const claude = fakeAgent({ script: () => [{ do: 'say', text: report(detail) }] });
    const codex = fakeAgent({ script: () => [{ do: 'say', text: report('Codex agrees with the summary and proposes loader merging.') }] });
    const llm = scriptedModel([
      agent('claude', 'Explain the persistence problem.'),
      call('task_result', { taskId: 'task:1' }),
      agent('codex', `Critique this summary of Claude’s reply.\n${summary}`),
      answer('The summary and critique support merging defaults in the loader.'),
    ]);
    const h = harness({ agents: { claude, codex }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Claude 의견을 네가 요약하고, Codex에게 그 요약을 검토시켜.');
    expect(llm.seen[2]?.at(-1)?.content).toContain(detail);
    expect(codex.prompts[0]).toContain(summary);
    expect(codex.prompts[0]).not.toContain(detail);
    expect(claude.prompts).toHaveLength(1);
    expect(codex.prompts).toHaveLength(1);
  });

  it('resolves every context reference before calling anyone and returns lookup errors for correction', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: report('ACTUAL_SOURCE_REPLY') }] });
    const codex = fakeAgent({ script: () => [{ do: 'say', text: report('Reviewed the source.') }] });
    const llm = scriptedModel([
      agent('claude', 'Give a proposal.'),
      agent('codex', 'Do not run with partial context.', [1, 999]),
      call('task_result', { taskId: 'task:999' }),
      agent('codex', 'Review the existing proposal.', [1, 1]),
      answer('Recovered using the existing result.'),
    ]);
    const h = harness({ agents: { claude, codex }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Compare the proposal.');
    expect(llm.seen[2]?.at(-1)?.content).toContain('Task 999 has no saved result');
    expect(llm.seen[2]?.at(-1)?.content).toContain('No agent was called');
    expect(llm.seen[3]?.at(-1)?.content).toContain('Cannot read task result');
    expect(codex.prompts).toHaveLength(1);
    expect(codex.prompts[0]).not.toContain('Do not run with partial context.');
    expect(codex.prompts[0]?.split('ACTUAL_SOURCE_REPLY')).toHaveLength(2);
  });

  it('forwards a failed result as evidence without deciding whether follow-up work should run', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: report('Missing the schema. Do not claim the implementation was verified.', 'blocked') }] });
    const codex = fakeAgent({ script: () => [{ do: 'say', text: report('Here is an alternative that can be assessed without the schema.') }] });
    const llm = scriptedModel([
      agent('claude', 'Assess the implementation.'),
      agent('codex', 'Explain the obstacle and propose another approach.', [1]),
      answer('The original assessment was blocked; Codex proposed an alternative.'),
    ]);
    const h = harness({ agents: { claude, codex }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Review and resolve the obstacle if possible.');
    expect(codex.prompts[0]).toContain('Task 1 (claude): blocked');
    expect(codex.prompts[0]).toContain('Missing the schema.');
    expect(codex.prompts).toHaveLength(1);
  });

  it('passes selected saved results after restarting the run without rerunning their source', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: report('PERSISTED_ORIGINAL_REPLY') }] });
    const codex = fakeAgent({ script: () => [{ do: 'say', text: report('Reviewed the persisted proposal.') }] });
    const first = harness({ agents: { claude, codex }, llm: scriptedModel([agent('claude', 'Propose a change.'), answer('Proposal saved.')]) });
    opened.push(first);
    await first.runtime.conversation.send('Ask Claude for a proposal.');
    await first.runtime.close();
    const resumed = harness({ agents: { claude, codex }, resume: { root: first.root, runId: first.runtime.workspace.id },
      llm: scriptedModel([agent('codex', 'Critique the existing proposal.', [1]), answer('Critique complete.')]) });
    opened.push(resumed);
    await resumed.runtime.conversation.send('Now let Codex review that proposal.');
    expect(claude.prompts).toHaveLength(1);
    expect(codex.prompts).toHaveLength(1);
    expect(codex.prompts[0]).toContain('PERSISTED_ORIGINAL_REPLY');
  });

  it('gives independent recipients the same selected sources without implicitly chaining new replies', async () => {
    const source = fakeAgent({ script: () => [{ do: 'say', text: report('SELECTED_SOURCE') }] });
    const claude = fakeAgent({ script: () => [{ do: 'say', text: report('CLAUDE_PRIVATE_NEW_ARGUMENT') + '\ndecided: - PRIVATE_DECISION\nopen: - PRIVATE_OPEN_ITEM' }] });
    const codex = fakeAgent({ script: () => [{ do: 'say', text: report('CODEX_INDEPENDENT_ARGUMENT') }] });
    const h = harness({ agents: { source, claude, codex }, llm: scriptedModel([
      agent('source', 'Propose a change.'), agent(['claude', 'codex'], 'Give independent assessments.', [1]), answer('Both assessments received.'),
    ]) });
    opened.push(h);
    await h.runtime.conversation.send('Ask for independent assessments of the proposal.');
    expect(claude.prompts[0]).toContain('SELECTED_SOURCE');
    expect(codex.prompts[0]).toContain('SELECTED_SOURCE');
    expect(codex.prompts[0]).not.toContain('CLAUDE_PRIVATE_NEW_ARGUMENT');
    expect(codex.prompts[0]).not.toContain('PRIVATE_DECISION');
    expect(codex.prompts[0]).not.toContain('PRIVATE_OPEN_ITEM');
    expect(codex.prompts[0]).not.toContain('Since your last task:');
  });

  it('keeps opening statements independent and gives the final synthesis every actual rebuttal', async () => {
    const opening = ['CLAUDE_OPEN: JS runs in browsers.', 'CODEX_OPEN: Python helps automate work.'];
    const closing = ['CLAUDE_CLOSE: Libraries are part of practical usefulness.', 'CODEX_CLOSE: Judge both ecosystems by the same standard.'];
    const claude = fakeAgent({ script: (_prompt, turn) => [{ do: 'say', text: turn === 0 ? opening[0]! : closing[0]! }] });
    const codex = fakeAgent({ script: (_prompt, turn) => [{ do: 'say', text: turn === 0 ? opening[1]! : closing[1]! }] });
    const llm = scriptedModel([
      agent(['claude', 'codex'], 'Give your opening position in three sentences.'),
      agent(['claude', 'codex'], 'Respond to the other opening in three sentences.', [1, 2]),
      answer('The shared criterion is practical usefulness; the final choice depends on the intended task.'),
    ]);
    const h = harness({ agents: { claude, codex }, llm });
    opened.push(h);
    await h.runtime.conversation.send('JS와 Python을 토론해. 각자 두 번씩, 발언마다 세 문장 이내.');
    expect(codex.prompts[0]).not.toContain(opening[0]);
    expect(claude.prompts[0]).not.toContain(opening[1]);
    for (const worker of [claude, codex]) {
      expect(worker.prompts).toHaveLength(2);
      for (const text of opening) expect(worker.prompts[1]).toContain(text);
      for (const prompt of worker.prompts) {
        expect(prompt).toContain('three sentences');
        expect(prompt).not.toContain('outcome: done | partial | blocked');
        expect(prompt).not.toContain('End your turn with a REPORT block.');
      }
    }
    expect(codex.prompts[1]).not.toContain(closing[0]);
    const finalContext = llm.seen[2]!.map((message) => message.content).join('\n');
    for (const text of [...opening, ...closing]) expect(finalContext.split(text)).toHaveLength(2);
    expect(h.runtime.executor.readOutcome(3)).toMatchObject({
      task: 'Respond to the other opening in three sentences.', contextFrom: [1, 2],
    });
    expect(llm.seen).toHaveLength(3);
  });

  it('keeps planner notes private unless the orchestrator includes them in a worker brief', async () => {
    const worker = fakeAgent({ script: () => [{ do: 'say', text: 'Independent answer.' }] });
    const llm = scriptedModel([
      JSON.stringify({ review: { objective: 'PRIVATE_PLANNER_OBJECTIVE', constraints: ['PRIVATE_PLANNER_NOTE'],
        completed: [], remaining: ['Get independent input'], next: 0, blocker: '' },
        ...JSON.parse(agent('worker', 'Evaluate this idea in two sentences.')) }),
      answer('Reviewed.'),
    ]);
    const h = harness({ agents: { worker }, llm });
    opened.push(h);
    await h.runtime.conversation.send('Evaluate this idea.');
    expect(worker.prompts[0]).not.toContain('PRIVATE_PLANNER_');
    expect(worker.prompts[0]).not.toContain('WORKING CONTEXT');
    expect(llm.seen[1]?.find((message) => message.pinned)?.content).toContain('PRIVATE_PLANNER_NOTE');
  });

  it('switches output requirements by task kind within a reused worker session', async () => {
    const worker = fakeAgent({ script: () => [{ do: 'say', text: 'Requested response.' }] });
    const h = harness({ agents: { worker }, llm: scriptedModel([
      call('agent', { agent: 'worker', prompt: 'Inspect the current behavior.', kind: 'inspect' }),
      agent('worker', 'Explain the tradeoff in two sentences.'),
      call('agent', { agent: 'worker', prompt: 'Implement and verify the chosen behavior.', kind: 'change' }),
      answer('Assessed, explained, and implemented.'),
    ]) });
    opened.push(h);
    await h.runtime.conversation.send('Inspect, explain the tradeoff briefly, then implement.');
    expect(worker.prompts).toHaveLength(3);
    const sessions = h.runtime.transcript.all().filter((record) => record.type === 'delegation').map((record) => record.sessionId);
    expect(new Set(sessions).size).toBe(1);
    for (const index of [0, 2]) {
      expect(worker.prompts[index]).toContain('outcome: done | partial | blocked');
      expect(worker.prompts[index]).toContain('verify:');
    }
    expect(worker.prompts[1]).toContain('do not append a REPORT block');
    expect(worker.prompts[1]).not.toContain('outcome: done | partial | blocked');
  });
});
