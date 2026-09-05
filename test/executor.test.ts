import { summarise } from '../src/orchestrator/results/outcome.js';
import { ResultTool } from '../src/orchestrator/conversation/tools/result.js';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, scriptedModel, type Harness } from './harness.js';
import { fakeAgent } from './fake-agent.js';
import { tasksSince } from '../src/orchestrator/context/ledger.js';
import { sessionMemory } from '../src/orchestrator/context/memory.js';
import { TaskRequestSchema } from '../src/contracts/task.js';
import { AgentProfileSchema } from '../src/config/schema.js';

const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0).reverse()) await h.dispose(); });
const report = (summary: string, status = 'done', extra = '') => `REPORT\noutcome: ${status}\nsummary: ${summary}\nchanged: none\nopen:\n${extra}`;
function setup(options: Parameters<typeof harness>[0]) { const h = harness(options); open.push(h); return h; }

describe('structured executor', () => {
  it.each([undefined, 'deny', 'allow'])('runs Codex with legacy nativeTools=%s through routing and direct sessions', async (nativeTools) => {
    const a = fakeAgent({ name: '@agentclientprotocol/codex-acp', loadSession: true, script: () => [{ do: 'say', text: report('Codex ran') }] });
    const h = setup({ agents: { a } });
    h.runtime.config.agents.a = AgentProfileSchema.parse({ ...h.runtime.config.agents.a, nativeTools });
    const connection = await h.runtime.pool.connection('a');
    expect(h.runtime.executor.candidates(TaskRequestSchema.parse({ task: 'Choose a worker' }))).toMatchObject([{ agent: 'a' }]);
    expect((await h.runtime.executor.execute({ task: 'Run explicitly', agent: 'a' })).status).toBe('done');
    expect((await h.runtime.executor.execute({ task: 'Run through automatic routing' })).status).toBe('done');
    const direct = await connection.newSession();
    await direct.prompt('Run directly', {});
    const resumed = await connection.loadSession(direct.sessionId);
    await resumed!.prompt('Resume directly', {});
    expect(a.prompts).toHaveLength(4);
    expect(h.runtime.config.agents.a).not.toHaveProperty('nativeTools');
  });

  it('schedules known native tasks exclusively without an opt-in setting', async () => {
    const a = fakeAgent({ name: 'codex-acp', script: () => [{ do: 'stall', ms: 20 }, { do: 'say', text: report('A') }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: report('B') }] });
    const h = setup({ agents: { a, b } });
    await h.runtime.pool.connection('a');
    await h.runtime.executor.batch({ tasks: [
      { id: 'a', request: { task: 'Inspect A', agent: 'a', kind: 'inspect' } },
      { id: 'b', request: { task: 'Inspect B', agent: 'b', kind: 'inspect' } },
    ] });
    const records = h.runtime.transcript.all();
    expect(records.find((r) => r.type === 'stop' && r.agentId === 'a')!.seq)
      .toBeLessThan(records.find((r) => r.type === 'delegation' && r.agentId === 'b')!.seq);
  });

  it('skips ACP selection by default and sends full tasks to an explicitly selected router', async () => {
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
    expect(llm.seen).toHaveLength(1);
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

  it('suggests the taskId for a mistaken record number but keeps existing task ids authoritative', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'Original task detail.' }] });
    const h = setup({ agents: { a } });
    const result = await h.runtime.executor.execute({ task: 'Inspect', agent: 'a' });
    const record = h.runtime.transcript.all().find((r) => r.type === 'task_result')!;
    expect(record.seq).not.toBe(result.taskId);
    expect(() => h.runtime.executor.readResult(record.seq, 100)).toThrow(`record:${record.seq} refers to task:${result.taskId}`);
    expect(() => h.runtime.executor.readResult(999999)).toThrow('Use a task reference from RESULT SOURCES');

    const other = summarise(record.seq, 'a', 'A different task', 'end_turn', [], 0);
    other.message = 'Different task detail.';
    h.runtime.executor.store(other);
    expect(JSON.parse(h.runtime.executor.readResult(record.seq).text).message).toBe('Different task detail.');
    expect(JSON.parse(h.runtime.executor.readResult(result.taskId).text).message).toBe('Original task detail.');
  });

  it.each(['missing', 'corrupt'])('returns a recoverable tool error for a %s result without claiming completion', async (failure) => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'Completed work.' }] });
    const h = setup({ agents: { a } });
    const result = await h.runtime.executor.execute({ task: 'Inspect', agent: 'a' });
    const file = path.join(h.runtime.workspace.runDir, 'results', `${result.taskId}.json`);
    if (failure === 'missing') fs.unlinkSync(file);
    else fs.writeFileSync(file, '{invalid json');

    const reply = await new ResultTool(h.runtime.executor).run({ taskId: `task:${result.taskId}`, offset: 0 });
    expect(reply.receipt).toMatchObject({ status: 'error', executed: false, created_tasks: [] });
    expect(reply.text).toMatch(/^Cannot read task result:/);
    expect(a.prompts).toHaveLength(1);
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
    const original = 'COUNTEREXAMPLE: a,,b loses the middle empty field.\n' + report('The parser drops empty tokens');
    const a = fakeAgent({ script: () => [{ do: 'say', text: original }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: report('Fixed') }] });
    const h = setup({ agents: { a, b } });
    await h.runtime.executor.batch({ tasks: [
      { id: 'review', request: { task: 'Review', kind: 'inspect', agent: 'a' } },
      { id: 'fix', dependsOn: ['review'], request: { task: 'Apply the findings', agent: 'b', constraints: ['Keep the API'] } },
    ] });
    expect(b.prompts[0]).toContain('Apply the findings');
    expect(b.prompts[0]).toContain('Keep the API');
    expect(b.prompts[0]).toContain('The parser drops empty tokens');
    expect(b.prompts[0]).toContain('Task 1 (a): done');
    expect(b.prompts[0]).toContain(original);
    expect(h.runtime.executor.readOutcome(2)).toMatchObject({
      task: 'Apply the findings\n\nConstraints (must preserve):\n- Keep the API', contextFrom: [1],
    });
  });

  it('attaches only explicitly selected results and rejects missing references before starting a worker', async () => {
    const original = ('SOURCE_ARGUMENT: validate before modifying.\n' + report('Reviewed validation')).trimEnd();
    const a = fakeAgent({ script: () => [{ do: 'say', text: original }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: 'Independent assessment.' }] });
    const h = setup({ agents: { a, b } });
    const source = await h.runtime.executor.execute({ task: 'Review', kind: 'answer', agent: 'a' });
    expect(source.message).toBe(original);
    await h.runtime.executor.execute({ task: 'Give an independent view', kind: 'answer', agent: 'b' });
    expect(b.prompts[0]).not.toContain('SOURCE_ARGUMENT');
    await expect(h.runtime.executor.execute({ task: 'Review sources', agent: 'b', contextFrom: [source.taskId, 999] })).rejects.toThrow('Task 999 has no saved result');
    expect(b.prompts).toHaveLength(1);
    await h.runtime.executor.execute({ task: 'Review sources', kind: 'answer', agent: 'b', contextFrom: [source.taskId, source.taskId] });
    expect(b.prompts[1]?.split(original)).toHaveLength(2);
    expect(h.runtime.executor.readOutcome(3)).toMatchObject({ task: 'Review sources', contextFrom: [source.taskId] });
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

  it('uses observed token usage to estimate later tasks', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: report('Small') },
      { do: 'stop', reason: 'end_turn', usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 } }] });
    const h = setup({ agents: { a } });
    await h.runtime.executor.execute({ task: 'First', agent: 'a' });
    const result = await h.runtime.executor.execute({ task: 'Second', agent: 'a', });
    expect(result.status).toBe('done');
    expect(a.prompts).toHaveLength(2);
  });

  it('keeps full sessions until explicitly rotated and rejects stale pins', async () => {
    const a = fakeAgent({ script: () => [{ do: 'update', update: { sessionUpdate: 'usage_update', used: 9000, size: 10000 } },
      { do: 'say', text: report('Done') }] });
    const h = setup({ agents: { a } });
    await h.runtime.executor.execute({ task: 'First', agent: 'a' });
    const original = h.runtime.pool.sessionId('a')!;
    await h.runtime.executor.execute({ task: 'Pinned', agent: 'a', sessionId: original });
    expect(h.runtime.pool.sessionId('a')).toBe(original);
    await h.runtime.executor.execute({ task: 'Continue', agent: 'a' });
    expect(h.runtime.pool.sessionId('a')).toBe(original);
    await h.runtime.pool.rotate('a');
    const refused = await h.runtime.executor.execute({ task: 'Stale', agent: 'a', sessionId: original });
    expect(refused.status).toBe('error');
    expect(a.prompts).toHaveLength(3);
  });

  it('runs host-mediated inspections concurrently without mixing reports or file records', async () => {
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

  it('records context growth without cancelling or rejecting later tasks', async () => {
    const a = fakeAgent({ script: () => [{ do: 'update', update: { sessionUpdate: 'usage_update', used: 5000, size: 10000 } }, { do: 'stall', ms: 20 }, { do: 'say', text: report('not reached') }] });
    const h = setup({ agents: { a } });
    const result = await h.runtime.executor.execute({ task: 'go', agent: 'a' });
    expect(result.status).toBe('done');
    expect(h.runtime.usage.totals().tokens).toBeGreaterThanOrEqual(5000);
    await expect(h.runtime.executor.execute({ task: 'again', agent: 'a' })).resolves.toMatchObject({ status: 'done' });
    expect(a.prompts).toHaveLength(2);
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

  it('invalidates files changed on disk and keeps source decisions retrievable', async () => {
    let file = '';
    const a = fakeAgent({ script: () => [{ do: 'tool', toolCallId: 'r', title: 'Read', kind: 'read', locations: [file] }, { do: 'say', text: report('read', 'done', 'decided: - preserve the legacy flag') }] });
    const h = setup({ agents: { a } }); file = path.join(h.workspaceDir, 'parser.ts'); fs.writeFileSync(file, 'old');
    await h.runtime.executor.execute({ task: 'parser.ts', kind: 'inspect', agent: 'a' });
    expect(sessionMemory(h.runtime.transcript, 'a').fresh).toContain(file);
    fs.writeFileSync(file, 'different content');
    expect(sessionMemory(h.runtime.transcript, 'a').stale).toContain(file);
    expect(h.runtime.executor.readOutcome(1).report.decided).toContain('preserve the legacy flag');
    const candidates = h.runtime.executor.candidates(TaskRequestSchema.parse({ task: 'parser.ts', files: ['parser.ts'] }));
    expect(candidates[0]?.reason).toContain('0 relevant unchanged files');
  });
});
