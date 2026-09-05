import { afterEach, describe, expect, it } from 'vitest';
import { harness, scriptedModel, type Harness } from './harness.js';
import { fakeAgent } from './fake-agent.js';
import type { ToolReceipt } from '../src/contracts/tool-result.js';
import type { ChatMessage } from '../src/models/client.js';

let open: Harness | undefined;
afterEach(async () => { await open?.dispose(); open = undefined; });
const invoke = (tool: string, input: unknown) => ({ tool, input });
const agent = (id: string, refs?: string[]) => invoke('agent', { agent: id, kind: 'answer', prompt: 'State your position in Korean; respond to any attached arguments.', ...(refs ? { context_from: refs } : {}) });
const step = (...calls: unknown[]) => JSON.stringify({ message: '', calls, finish: false });
const finish = (message: string) => JSON.stringify({ message, calls: [], finish: true });
const receipts = (messages: ChatMessage[]): ToolReceipt[] => messages.filter((message) => message.content.startsWith('TOOL RESULT'))
  .map((message) => JSON.parse(message.content.split('\n').find((line) => line.startsWith('{'))!) as ToolReceipt);

describe('task and record references', () => {
  it('returns non-execution facts, distinguishes result reads, and preserves corrected source replies', async () => {
    const claude = fakeAgent({ script: (_prompt, turn) => [{ do: 'say', text: `CLAUDE_REPLY_${turn + 1}\n고유한 주장과 근거입니다.` }] });
    const codex = fakeAgent({ script: (_prompt, turn) => [{ do: 'say', text: `CODEX_REPLY_${turn + 1}\n반론의 실제 원문입니다.` }] });
    const llm = scriptedModel([
      step(agent('claude'), agent('codex')),
      step(agent('claude', ['task:2']), agent('codex', ['task:1'])),
      step(agent('claude', ['task:1195', 'task:1618']), agent('codex', ['task:1195', 'task:1618'])),
      step(invoke('task_result', { taskId: 'task:3' }), invoke('task_result', { taskId: 'task:4' })),
      step(agent('claude', ['task:4']), agent('codex', ['task:3'])),
      finish('각자 세 번 발언했고 마지막 반론까지 종합했습니다.'),
    ]);
    open = harness({ agents: { claude, codex }, llm });
    await open.runtime.conversation.send('js vs python 어느게 좋은지 @claude , @codex 토론해. 단 발언권 각 3회씩.');
    const failures = receipts(llm.seen[3]!).slice(-2);
    for (const failure of failures) expect(failure).toEqual({ status: 'error', executed: false, created_tasks: [],
      error: { code: 'invalid_task_reference', message: expect.stringContaining('No agent was called'), valid_refs: ['task:1', 'task:2', 'task:3', 'task:4'] } });
    const reads = receipts(llm.seen[4]!).slice(-2);
    expect(reads).toEqual(['task:3', 'task:4'].map((ref) => ({ status: 'ok', executed: true, created_tasks: [], observed_tasks: [ref] })));
    expect(claude.prompts).toHaveLength(3);
    expect(codex.prompts).toHaveLength(3);
    expect(claude.prompts[2]).toContain('CODEX_REPLY_2\n반론의 실제 원문입니다.');
    expect(codex.prompts[2]).toContain('CLAUDE_REPLY_2\n고유한 주장과 근거입니다.');
    expect(open.runtime.transcript.all().filter((record) => record.type === 'delegation')).toHaveLength(6);
    const finalInput = llm.seen[5]!.map((message) => message.content).join('\n');
    expect(finalInput).toContain('CLAUDE_REPLY_3');
    expect(finalInput).toContain('CODEX_REPLY_3');
    expect(finalInput).toContain('record:');
    expect(finalInput).toContain('task:6');
  });

  it('rejects record references before any calls execute, even when the numeric task exists', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'Exact source' }] });
    const llm = scriptedModel([step(agent('claude')), step(agent('claude'), agent('claude', ['record:1'])),
      finish('잘못된 참조로 다음 호출은 실행하지 못했습니다.')]);
    open = harness({ agents: { claude }, llm });
    await open.runtime.conversation.send('검토해.');
    expect(claude.prompts).toHaveLength(1);
    expect(llm.seen[2]?.at(-1)?.content).toContain('No tools from that response were executed');
    expect(llm.seen[2]?.at(-1)?.content).toContain('task:1');
  });

  it('leaves the next action and incomplete reports to the model without enforcing a discussion count', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'First reply' }] });
    const llm = scriptedModel([step(agent('claude')), step(agent('claude', ['task:1195'])),
      finish('한 번 발언했고, 참조 오류로 나머지는 진행하지 못했습니다.')]);
    open = harness({ agents: { claude }, llm });
    await open.runtime.conversation.send('Claude가 세 번 발언해.');
    expect(claude.prompts).toHaveLength(1);
    expect(llm.seen).toHaveLength(3);
    expect(open.runtime.transcript.all().filter((record) => record.type === 'assistant').at(-1)).toMatchObject({ text: expect.stringContaining('진행하지 못했습니다') });
  });

  it('resolves all references before queuing background work', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'Source reply' }] });
    const llm = scriptedModel([step(agent('claude')),
      step(invoke('agent', { agent: 'claude', kind: 'answer', prompt: 'React to these sources.', background: true,
        context_from: ['task:1', 'task:1195'] })), finish('참조 오류로 후속 작업은 시작되지 않았습니다.')]);
    open = harness({ agents: { claude }, llm });
    await open.runtime.conversation.send('의견을 모으고 후속 작업을 진행해.');
    expect(claude.prompts).toHaveLength(1);
    expect(open.runtime.transcript.all().filter((record) => record.type === 'agent_job')).toEqual([]);
    expect(receipts(llm.seen[2]!).at(-1)).toMatchObject({ status: 'error', executed: false, created_tasks: [],
      error: { code: 'invalid_task_reference', valid_refs: ['task:1'] } });
  });
});
