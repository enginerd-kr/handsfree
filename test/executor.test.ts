import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, scriptedModel, type Harness } from './harness.js';
import { fakeAgent } from './fake-agent.js';
import { tasksSince } from '../src/orchestrator/ledger.js';
import { sessionMemory, durableFacts } from '../src/orchestrator/memory.js';
import { TaskRequestSchema } from '../src/orchestrator/contract.js';

const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0).reverse()) await h.dispose(); });
const report = (summary: string, status = 'done', extra = '') => `REPORT\noutcome: ${status}\nsummary: ${summary}\nchanged: none\nopen:\n${extra}`;
function setup(options: Parameters<typeof harness>[0]) { const h = harness(options); open.push(h); return h; }

describe('structured executor', () => {
  it('refuses an identified native Codex adapter before creating a task or charging tokens', async () => {
    const a = fakeAgent({ name: '@agentclientprotocol/codex-acp', script: () => [{ do: 'say', text: 'must not run' }] });
    const h = setup({ agents: { a } });
    await h.runtime.pool.connection('a');
    await expect(h.runtime.executor.execute({ task: 'Run a command', agent: 'a' })).rejects.toThrow('outside host policy');
    await expect(h.runtime.pool.session('a')).rejects.toThrow('outside host policy');
    expect(a.prompts).toHaveLength(0);
    expect(h.runtime.budget.totals().tokens).toBe(0);
  });

  it('allows explicit native opt-in but schedules those tasks exclusively', async () => {
    const a = fakeAgent({ name: 'codex-acp', script: () => [{ do: 'stall', ms: 20 }, { do: 'say', text: report('A') }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: report('B') }] });
    const h = setup({ agents: { a, b }, config: { profiles: { a: { nativeTools: 'allow' } } } });
    await h.runtime.executor.batch({ tasks: [
      { id: 'a', request: { task: 'Inspect A', agent: 'a', kind: 'inspect' } },
      { id: 'b', request: { task: 'Inspect B', agent: 'b', kind: 'inspect' } },
    ] });
    const records = h.runtime.transcript.all();
    expect(records.find((r) => r.type === 'stop' && r.agentId === 'a')!.seq)
      .toBeLessThan(records.find((r) => r.type === 'delegation' && r.agentId === 'b')!.seq);
  });

  it('skips an ACP selector by default and preserves a task too large for the small routing window', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: report('A') }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: report('B') }] });
    const llm = scriptedModel([]);
    const h = setup({ agents: { a, b }, llm, config: { orchestration: { provider: 'acp', acp: { agent: 'a' } } } });
    await h.runtime.executor.execute({ task: 'Choose a worker', kind: 'answer' });
    expect(llm.seen).toHaveLength(0);
    h.runtime.config.orchestration.provider = 'local';
    const task = 'Exact requirement: ' + 'keep this constraint. '.repeat(400);
    const result = await h.runtime.executor.execute({ task, kind: 'answer' });
    expect(result.status).toBe('done');
    expect([...a.prompts, ...b.prompts].some((prompt) => prompt.includes(task.trim()))).toBe(true);
    expect(llm.seen).toHaveLength(0);
  });
  it('preserves exact constraints, returns a compact result and retrieves the full answer without a planner', async () => {
    const detail = 'IMPORTANT_DETAIL: retain retry ordering. ' + 'Explanation. '.repeat(200);
    const agent = fakeAgent({ script: () => [{ do: 'say', text: detail + '\n' + report('Reviewed retry ordering') }] });
    const llm = scriptedModel([]);
    const h = setup({ agents: { a: agent }, llm });
    const result = await h.runtime.executor.execute({ task: 'Review retries', agent: 'a', kind: 'inspect', constraints: ['Preserve legacy behavior'], acceptanceCriteria: ['Explain ordering'] });
    expect(agent.prompts[0]).toContain('Preserve legacy behavior');
    expect(agent.prompts[0]).toContain('Explain ordering');
    expect(result.status).toBe('done');
    expect(result.summary).toBe('Reviewed retry ordering');
    expect(llm.seen).toHaveLength(0);
    const page = h.runtime.executor.readResult(result.taskId, 0, 200);
    expect(page.nextOffset).toBe(200);
    let text = page.text, offset = page.nextOffset;
    while (offset !== undefined) { const next = h.runtime.executor.readResult(result.taskId, offset, 200); text += next.text; offset = next.nextOffset; }
    expect(JSON.parse(text).message).toContain(detail);
    expect(result.usage?.estimated).toBe(true);
  });

  it('deduplicates concurrent requests and rejects reuse with different requirements', async () => {
    const a = fakeAgent({ script: () => [{ do: 'stall', ms: 20 }, { do: 'say', text: report('done') }] });
    const h = setup({ agents: { a } });
    const request = { task: 'implement', agent: 'a', requestId: 'id-1' };
    const [first, second] = await Promise.all([h.runtime.executor.execute(request), h.runtime.executor.execute(request)]);
    expect(first).toEqual(second);
    expect(a.prompts).toHaveLength(1);
    expect(await h.runtime.executor.execute(request)).toEqual(first);
    await expect(h.runtime.executor.execute({ ...request, task: 'different' })).rejects.toThrow('different request');
  });

  it('blocks failed prerequisites, including a report saying blocked after end_turn', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: report('Need a key', 'blocked', 'open: - missing key') }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: report('should not run') }] });
    const h = setup({ agents: { a, b } });
    const result = await h.runtime.executor.batch({ tasks: [
      { id: 'inspect', request: { task: 'inspect', agent: 'a', kind: 'inspect' } },
      { id: 'edit', dependsOn: ['inspect'], request: { task: 'edit', agent: 'b' } },
    ] });
    expect(result.inspect?.status).toBe('blocked');
    expect(result.edit?.status).toBe('blocked');
    expect(b.prompts).toHaveLength(0);
    expect(tasksSince(h.runtime.transcript.all(), 0)[0]?.outcome.status).toBe('blocked');
  });

  it('rejects invalid graphs before executing anything', async () => {
    const a = fakeAgent({ script: () => [] });
    const h = setup({ agents: { a } });
    await expect(h.runtime.executor.batch({ tasks: [
      { id: 'x', dependsOn: ['y'], request: { task: 'x' } },
      { id: 'y', dependsOn: ['x'], request: { task: 'y' } },
    ] })).rejects.toThrow('Cyclic');
    expect(a.prompts).toHaveLength(0);
  });

  it('passes prerequisite findings to another worker without rewriting the requested task', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: report('The parser drops empty tokens') }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: report('Fixed') }] });
    const h = setup({ agents: { a, b } });
    await h.runtime.executor.batch({ tasks: [
      { id: 'review', request: { task: 'Review', kind: 'inspect', agent: 'a' } },
      { id: 'fix', dependsOn: ['review'], request: { task: 'Apply the findings', agent: 'b', constraints: ['Keep the API'] } },
    ] });
    expect(b.prompts[0]).toContain('Apply the findings');
    expect(b.prompts[0]).toContain('Keep the API');
    expect(b.prompts[0]).toContain('The parser drops empty tokens');
    expect(b.prompts[0]).toContain('handsfree://runs/');
  });

  it('reuses results after restart and refuses indeterminate journal entries', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: report('Saved') }] });
    const h = setup({ agents: { a } });
    const request = { task: 'Once', agent: 'a', requestId: 'persisted' };
    const first = await h.runtime.executor.execute(request);
    await h.runtime.close();
    const restarted = setup({ agents: { a }, resume: { root: h.root, runId: h.runtime.workspace.id } });
    expect(await restarted.runtime.executor.execute(request)).toEqual(first);
    expect(a.prompts).toHaveLength(1);
    const journal = path.join(h.runtime.workspace.runDir, 'requests');
    const file = path.join(journal, fs.readdirSync(journal)[0]!);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ fingerprint: saved.fingerprint, state: 'running' }));
    await expect(restarted.runtime.executor.execute(request)).rejects.toThrow('interrupted');
    expect(a.prompts).toHaveLength(1);
  });

  it('uses observed task costs consistently for shortlist and execution admission', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: report('Small') },
      { do: 'stop', reason: 'end_turn', usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 } }] });
    const h = setup({ agents: { a }, config: { budget: { maxTokens: 4500 } } });
    await h.runtime.executor.execute({ task: 'First', agent: 'a' });
    const result = await h.runtime.executor.execute({ task: 'Second', agent: 'a', budget: { maxTokens: 1000 } });
    expect(result.status).toBe('done');
    expect(a.prompts).toHaveLength(2);
  });

  it('rotates full sessions but honors exact session pins and rejects stale pins', async () => {
    const a = fakeAgent({ script: () => [{ do: 'update', update: { sessionUpdate: 'usage_update', used: 9000, size: 10000 } },
      { do: 'say', text: report('Done') }] });
    const h = setup({ agents: { a } });
    await h.runtime.executor.execute({ task: 'First', agent: 'a' });
    const original = h.runtime.pool.sessionId('a')!;
    await h.runtime.executor.execute({ task: 'Pinned', agent: 'a', sessionId: original });
    expect(h.runtime.pool.sessionId('a')).toBe(original);
    await h.runtime.executor.execute({ task: 'Rotate', agent: 'a' });
    expect(h.runtime.pool.sessionId('a')).not.toBe(original);
    const refused = await h.runtime.executor.execute({ task: 'Stale', agent: 'a', sessionId: original });
    expect(refused.status).toBe('error');
    expect(a.prompts).toHaveLength(3);
  });

  it('runs inspections concurrently without mixing reports or file records', async () => {
    const a = fakeAgent({ script: () => [{ do: 'stall', ms: 30 }, { do: 'say', text: report('Only A') }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: report('Only B') }] });
    const h = setup({ agents: { a, b } });
    const result = await h.runtime.executor.batch({ tasks: [
      { id: 'a', request: { task: 'a', agent: 'a', kind: 'inspect' } },
      { id: 'b', request: { task: 'b', agent: 'b', kind: 'inspect' } },
    ] });
    expect(result.a).toMatchObject({ summary: 'Only A' });
    expect(result.b).toMatchObject({ summary: 'Only B' });
    const records = h.runtime.transcript.all();
    const delegated = records.filter((r) => r.type === 'delegation');
    const stops = records.filter((r) => r.type === 'stop');
    expect(delegated[1]!.seq).toBeLessThan(stops[0]!.seq);
    for (const task of tasksSince(records, 0)) expect(task.outcome.message).not.toContain(task.outcome.agentId === 'a' ? 'Only B' : 'Only A');
  });

  it('serializes changes and lets bypass approve requests regardless of task kind', async () => {
    let target = '';
    const attempted: boolean[] = [];
    const a = fakeAgent({ script: () => [{ do: 'stall', ms: 20 }, { do: 'say', text: report('A') }] });
    const b = fakeAgent({ script: () => [{ do: 'write', path: target, content: 'bad', onResult: (r) => attempted.push(r.ok) }, { do: 'say', text: report('B') }] });
    const h = setup({ agents: { a, b } }); target = path.join(h.workspaceDir, 'x.txt');
    h.runtime.policy.setMode('bypass');
    await h.runtime.executor.batch({ tasks: [
      { id: 'a', request: { task: 'change', agent: 'a', kind: 'change' } },
      { id: 'b', request: { task: 'inspect', agent: 'b', kind: 'inspect' } },
    ] });
    const records = h.runtime.transcript.all();
    expect(records.find((r) => r.type === 'stop' && r.agentId === 'a')!.seq).toBeLessThan(records.find((r) => r.type === 'delegation' && r.agentId === 'b')!.seq);
    expect(attempted).toEqual([true]);
    expect(fs.readFileSync(target, 'utf8')).toBe('bad');
    expect(b.prompts[0]).toContain('Do not modify files or run commands');
  });

  it('cancels on reported context growth and refuses later work over the run budget', async () => {
    const a = fakeAgent({ script: () => [{ do: 'update', update: { sessionUpdate: 'usage_update', used: 5000, size: 10000 } }, { do: 'stall', ms: 20 }, { do: 'say', text: report('not reached') }] });
    const h = setup({ agents: { a }, config: { budget: { maxTokens: 4500 } } });
    const result = await h.runtime.executor.execute({ task: 'go', agent: 'a' });
    expect(result.status).toBe('budget_exceeded');
    expect(h.runtime.budget.totals().tokens).toBeGreaterThanOrEqual(5000);
    await expect(h.runtime.executor.execute({ task: 'again', agent: 'a' })).rejects.toThrow('budget');
    expect(a.prompts).toHaveLength(1);
  });

  it('uses a bounded selector and falls back without retries when its JSON is invalid', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: report('A') }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: report('B') }] });
    const llm = scriptedModel(['not JSON']);
    const h = setup({ agents: { a, b }, llm });
    const result = await h.runtime.executor.execute({ task: 'Review parser', kind: 'inspect' });
    expect(result.agent).toBe('a');
    expect(llm.seen).toHaveLength(1);
    expect(llm.seen[0]!.map((m) => m.content).join('')).toContain('Do not rewrite the task');
  });

  it('invalidates files changed on disk and retains older decisions beyond the recent window', async () => {
    let file = '';
    const a = fakeAgent({ script: () => [{ do: 'tool', toolCallId: 'r', title: 'Read', kind: 'read', locations: [file] }, { do: 'say', text: report('read', 'done', 'decided: - preserve the legacy flag') }] });
    const h = setup({ agents: { a } }); file = path.join(h.workspaceDir, 'parser.ts'); fs.writeFileSync(file, 'old');
    await h.runtime.executor.execute({ task: 'parser.ts', kind: 'inspect', agent: 'a' });
    expect(sessionMemory(h.runtime.transcript, 'a').fresh).toContain(file);
    fs.writeFileSync(file, 'different content');
    expect(sessionMemory(h.runtime.transcript, 'a').stale).toContain(file);
    expect(durableFacts(h.runtime.transcript, h.workspaceDir, 'parser')).toContain('preserve the legacy flag');
    const candidates = h.runtime.executor.candidates(TaskRequestSchema.parse({ task: 'parser.ts', files: ['parser.ts'] }));
    expect(candidates[0]?.reason).toContain('0 relevant unchanged files');
  });
});
