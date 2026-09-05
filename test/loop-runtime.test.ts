import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatClient, ChatMessage } from '../src/models/client.js';
import { RunContext } from '../src/orchestrator/context/context.js';
import { WorkMode } from '../src/orchestrator/context/work-mode.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import { fakeAgent } from './fake-agent.js';

let open: Harness | undefined;
afterEach(async () => { await open?.dispose(); open = undefined; });
const finish = (message: string) => JSON.stringify({ message, calls: [], finish: true });
const call = (tool: string, input: unknown) => ({ tool, input });
const step = (...calls: unknown[]) => JSON.stringify({ message: '먼저 근거를 확인하겠습니다.', calls, finish: false });
const worker = (agent: string, background = false) => call('agent', { agent, kind: 'answer', prompt: 'Give your argument.', background });

describe('continuous agent loop', () => {
  it('shows commentary, runs every call and synthesizes complete results in the next step', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'A exact argument' }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: 'B exact rebuttal' }] });
    const llm = scriptedModel([step(worker('a'), worker('b')), finish('종합 결과')]);
    open = harness({ agents: { a, b }, llm });
    await open.runtime.conversation.send('Compare their arguments.');
    const records = open.runtime.transcript.all();
    expect(records.findIndex((r) => r.type === 'assistant' && r.text.includes('근거')))
      .toBeLessThan(records.findIndex((r) => r.type === 'delegation'));
    const context = llm.seen[1]!.map((message) => message.content).join('\n');
    expect(context.match(/A exact argument/g)).toHaveLength(1);
    expect(context.match(/B exact rebuttal/g)).toHaveLength(1);
    expect(context).toContain('Call 2:');
  });

  it('validates an entire group before executing any call', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'should not run' }] });
    open = harness({ agents: { a }, llm: scriptedModel([step(worker('a'), call('missing_tool', {})), finish('Corrected')]) });
    await open.runtime.conversation.send('Check');
    expect(a.prompts).toHaveLength(0);
  });

  it('applies mid-tool steering and accounts for unstarted calls without losing evidence', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'The first result survives.' }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: 'should not run' }] });
    const llm = scriptedModel([step(worker('a'), worker('b')), finish('이제 결론만 답합니다.')]);
    open = harness({ agents: { a, b }, llm });
    let update: Promise<void> | undefined;
    open.runtime.transcript.on('record', (record) => {
      if (record.type === 'delegation' && record.agentId === 'a') update = open!.runtime.conversation.send('이제 결론만. B는 부르지 마.');
    });
    await open.runtime.conversation.send('Compare arguments, keeping the original format.');
    await update;
    expect(a.prompts).toHaveLength(1);
    expect(b.prompts).toHaveLength(0);
    const sent = llm.seen[1]!.map((message) => message.content).join('\n');
    expect(sent).toContain('The first result survives.');
    expect(sent).toContain('Not executed:');
    expect(sent).toContain('USER UPDATE:\n이제 결론만');
    const restored = new RunContext(open.runtime.transcript).history().map((message) => message.content).join('\n');
    expect(restored).toContain('original format');
    expect(restored).toContain('B는 부르지 마');
    expect(open.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(2);
  });

  it('reconsiders a stale final answer when a user update arrived during generation', async () => {
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const seen: ChatMessage[][] = [];
    const llm: ChatClient = { async chat(messages) {
      seen.push([...messages]);
      if (seen.length === 1) { started(); await held; return finish('stale answer'); }
      return finish('updated answer');
    } };
    open = harness({ agents: {}, llm });
    const turn = open.runtime.conversation.send('Original request');
    await ready;
    const update = open.runtime.conversation.send('New constraint');
    release();
    await Promise.all([turn, update]);
    expect(seen[1]!.at(-1)?.content).toContain('New constraint');
    expect(open.runtime.transcript.all().filter((r) => r.type === 'assistant').map((r) => r.text)).toEqual(['updated answer']);
  });

  it('prepares a durable plan and resumes execution without changing permissions', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'implemented' }] });
    const plan = '# Plan\nPreserve the source arguments.\nVerify the loop with regression tests.';
    const llm = scriptedModel([
      step(call('agent', { agent: 'a', kind: 'change', prompt: 'Premature edit' })),
      step(call('plan', { operation: 'save', text: plan })), finish('계획을 저장했습니다.'),
      step(call('agent', { agent: 'a', kind: 'change', prompt: 'Implement the saved plan.' })), finish('Implemented'),
    ]);
    open = harness({ agents: { a }, llm });
    open.runtime.policy.setMode('bypass');
    await open.runtime.conversation.send('/plan Improve the loop');
    expect(open.runtime.conversation.mode).toBe('plan');
    expect(a.prompts).toHaveLength(0);
    expect(fs.readFileSync(path.join(open.runtime.workspace.runDir, 'plan.md'), 'utf8')).toBe(plan);
    expect(new WorkMode(open.runtime.transcript, open.runtime.workspace.runDir).state()).toEqual({ mode: 'plan', plan });
    await open.runtime.conversation.send('/execute');
    expect(open.runtime.conversation.mode).toBe('execute');
    expect(open.runtime.policy.mode).toBe('bypass');
    expect(a.prompts).toHaveLength(1);
    expect(llm.seen[3]!.map((message) => message.content).join('\n')).toContain(plan);
  });

  it('runs independent background calls concurrently and follows up through the same session', async () => {
    const a = fakeAgent({ script: (_prompt, turn) => [{ do: 'stall', ms: 30 }, { do: 'say', text: `A response ${turn}` }] });
    const b = fakeAgent({ script: () => [{ do: 'stall', ms: 30 }, { do: 'say', text: 'B exact response' }] });
    const llm = scriptedModel([
      step(worker('a', true), worker('b', true)),
      step(call('agent_job', { operation: 'wait', jobIds: [1, 2] })),
      step(call('agent_job', { operation: 'followup', jobId: 1, prompt: 'Respond to B.', kind: 'answer', context_from: [2] })),
      step(call('agent_job', { operation: 'wait', jobIds: [3] })), finish('Debate synthesized'),
    ]);
    open = harness({ agents: { a, b }, llm });
    let active = 0, peak = 0;
    open.runtime.transcript.on('record', (record) => {
      if (record.type === 'delegation') peak = Math.max(peak, ++active);
      if (record.type === 'stop') active--;
    });
    await open.runtime.conversation.send('Compare and discuss.');
    expect(peak).toBe(2);
    expect(a.prompts).toHaveLength(2);
    expect(a.prompts[1]).toContain('B exact response');
    const sessions = open.runtime.transcript.all().flatMap((r) => r.type === 'delegation' && r.agentId === 'a' ? [r.sessionId] : []);
    expect(new Set(sessions).size).toBe(1);
    const sent = llm.seen[4]!.map((message) => message.content).join('\n');
    expect(sent).toContain('A response 1');
    expect(sent).toContain('B exact response');
  });

  it('waits for outstanding work before accepting a final report', async () => {
    const a = fakeAgent({ script: () => [{ do: 'stall', ms: 25 }, { do: 'say', text: 'Actual evidence' }] });
    const llm = scriptedModel([step(worker('a', true)), finish('Premature report'), finish('Evidence-based report')]);
    open = harness({ agents: { a }, llm });
    await open.runtime.conversation.send('Inspect then report');
    expect(llm.seen[2]!.map((message) => message.content).join('\n')).toContain('Actual evidence');
    const replies = open.runtime.transcript.all().filter((r) => r.type === 'assistant').map((r) => r.text);
    expect(replies).not.toContain('Premature report');
    expect(replies.at(-1)).toBe('Evidence-based report');
  });

  it('wakes a background wait on user steering without cancelling the worker', async () => {
    const a = fakeAgent({ script: () => [{ do: 'stall', ms: 50 }, { do: 'say', text: 'completed before requested conclusion' }] });
    const llm = scriptedModel([step(worker('a', true)), step(call('agent_job', { operation: 'wait', jobIds: [1] })),
      step(call('agent_job', { operation: 'wait', jobIds: [1] })), finish('short conclusion')]);
    open = harness({ agents: { a }, llm });
    let update: Promise<void> | undefined;
    open.runtime.transcript.on('record', (record) => {
      if (record.type === 'context' && record.entry.event === 'step' && record.entry.action.includes('"operation":"wait"') && !update) {
        queueMicrotask(() => { update = open!.runtime.conversation.send('Keep waiting, but make the conclusion short.'); });
      }
    });
    await open.runtime.conversation.send('Collect evidence.');
    await update;
    expect(llm.seen[2]!.map((message) => message.content).join('\n')).toContain('make the conclusion short');
    expect(open.runtime.transcript.all().filter((r) => r.type === 'stop').at(-1)).toMatchObject({ status: 'done' });
  });

  it('checkpoints overflowing history while retaining exact latest evidence and original sources', async () => {
    const old = 'old argument '.repeat(2000);
    const a = fakeAgent({ script: (_prompt, turn) => [{ do: 'say', text: turn === 0 ? old : 'Latest exact rebuttal' }] });
    const seen: ChatMessage[][] = [];
    const llm: ChatClient = { async chat(messages) {
      seen.push([...messages]);
      if (seen.length <= 2) return step(worker('a'));
      if (seen.length === 3) throw { status: 400, message: 'maximum context length exceeded' };
      return finish('Synthesis after recovery');
    } };
    open = harness({ agents: { a }, llm });
    await open.runtime.conversation.send('Review; do not change files.');
    const recovered = seen[3]!.map((message) => message.content).join('\n');
    expect(recovered).not.toContain(old);
    expect(recovered).toContain('Latest exact rebuttal');
    expect(recovered).toContain('do not change files');
    expect(recovered).toContain('HISTORY CHECKPOINT:');
    const checkpoint = open.runtime.transcript.all().find((r) => r.type === 'context' && r.entry.event === 'checkpoint')!;
    const context = new RunContext(open.runtime.transcript);
    expect(context.read(checkpoint.seq, 0).text.includes(old.trim())).toBe(true);
    const page = context.read(checkpoint.seq, 0, 500);
    expect(page.text).toHaveLength(500);
    expect(page.nextOffset).toBe(500);
    expect(open.runtime.executor.readOutcome(1).message).toBe(old.trim());
  });
});
