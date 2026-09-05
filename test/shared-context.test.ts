import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatClient, ChatMessage } from '../src/models/client.js';
import type { ToolReceipt } from '../src/contracts/tool-result.js';
import type { SharedContextSelection } from '../src/contracts/shared-context.js';
import { SharedConversations } from '../src/orchestrator/context/shared.js';
import { harness, type Harness } from './harness.js';
import { fakeAgent } from './fake-agent.js';

const opened: Harness[] = [];
afterEach(async () => { for (const h of opened.splice(0).reverse()) await h.dispose(); });
const step = (tool: string, input: unknown) => JSON.stringify({ message: '', calls: [{ tool, input }], finish: false });
const finish = () => JSON.stringify({ message: 'Completed using the actual shared replies.', calls: [], finish: true });
const receipt = (messages: ChatMessage[]): ToolReceipt => {
  const result = messages.findLast((message) => message.content.startsWith('TOOL RESULT'))!.content;
  return JSON.parse(result.split('\n').find((line) => line.startsWith('{'))!);
};
const head = (messages: ChatMessage[]) => receipt(messages).conversation_head!;
const worker = (agent: string | string[], shared_context: SharedContextSelection, extra = {}) => step('agent', {
  agent, kind: 'answer', prompt: 'CURRENT_ASSIGNMENT: give your next response to the selected conversation.', shared_context, ...extra,
});
const sharedPart = (prompt: string) => prompt.slice(prompt.indexOf('SHARED CONVERSATION ('), prompt.indexOf('END SHARED CONVERSATION'));
function model(steps: ((messages: ChatMessage[]) => string | Promise<string>)[]): ChatClient & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return { seen, async chat(messages) {
    seen.push([...messages]);
    const next = steps[seen.length - 1];
    if (!next) throw new Error('Unexpected model call');
    return next(messages);
  } };
}

describe('explicit shared conversation delivery', () => {
  it.each([false, true])('recovers an opening call batched with scope creation but missing its selection (background=%s)', async (background) => {
    const claude = fakeAgent({ script: (_p, turn) => [{ do: 'say', text: `CLAUDE_${turn + 1}: original Python position` }] });
    const codex = fakeAgent({ script: (_p, turn) => [{ do: 'say', text: `CODEX_${turn + 1}: original position` }] });
    const llm = model([
      // The real Gemini run opened the scope and omitted it from this same batch's first call.
      () => JSON.stringify({ message: '', calls: [
        { tool: 'shared_context', input: { operation: 'open', title: 'JavaScript vs Python Debate' } },
        { tool: 'agent', input: { agent: ['claude', 'codex'], kind: 'answer', prompt: 'Opening argument.', background } },
      ], finish: false }),
      (m) => {
        const rejected = receipt(m);
        expect(rejected).toMatchObject({ status: 'error', executed: false, created_tasks: [], error: { code: 'shared_context_required' } });
        expect(claude.prompts).toHaveLength(0); expect(codex.prompts).toHaveLength(0);
        const [conversation, through] = rejected.error!.valid_refs!;
        return worker(['claude', 'codex'], { conversation: conversation!, through: through! });
      },
      (m) => worker(['claude', 'codex'], head(m)),
      (m) => worker(['claude', 'codex'], head(m)), finish,
    ]);
    const h = harness({ agents: { claude, codex }, llm }); opened.push(h);
    await h.runtime.conversation.send('js vs python 어느게 좋은지 @claude 와 @codex 토론해. 발언은 각 3회로 제한.');
    for (const participant of [claude, codex]) {
      expect(participant.prompts).toHaveLength(3);
      expect(participant.prompts[1]).toContain('CLAUDE_1: original Python position');
      expect(participant.prompts[1]).toContain('CODEX_1: original position');
      expect(participant.prompts[2]).toContain('CLAUDE_1: original Python position');
      expect(participant.prompts[2]).toContain('CODEX_1: original position');
      expect(participant.prompts[2]).toContain('CLAUDE_2');
      expect(participant.prompts[2]).toContain('CODEX_2');
    }
    const records = h.runtime.transcript.all();
    expect(records.filter((r) => r.type === 'agent_job')).toHaveLength(0);
    expect(records.filter((r) => r.type === 'delegation')).toHaveLength(6);
    expect(records.filter((r) => r.type === 'shared_context' && r.entry.event === 'reply')).toHaveLength(6);
  });

  it('allows an explicitly ordinary background call and does not require choices for unrelated later user turns', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'OUTSIDE_REPLY' }] });
    let selected!: SharedContextSelection;
    const llm = model([
      () => step('shared_context', { operation: 'open', title: 'Separate collaboration' }),
      (m) => { selected = head(m); return step('agent', { agent: 'a', kind: 'answer', prompt: 'Independent check.', shared_context: null, background: true }); },
      () => step('agent_job', { operation: 'wait', jobIds: ['job:1'] }),
      () => step('agent_job', { operation: 'followup', jobId: 'job:1', prompt: 'Follow up outside the scope.', shared_context: null }),
      () => step('agent_job', { operation: 'wait', jobIds: ['job:2'] }), finish,
      () => step('agent', { agent: 'a', kind: 'answer', prompt: 'Unrelated later request.' }), finish,
    ]);
    const h = harness({ agents: { a }, llm }); opened.push(h);
    await h.runtime.conversation.send('Start a collaboration and do an unrelated check.');
    await h.runtime.conversation.send('A different topic.');
    expect(a.prompts).toHaveLength(3);
    expect(a.prompts.every((prompt) => !prompt.includes('SHARED CONVERSATION'))).toBe(true);
    const shared = new SharedConversations(h.runtime.transcript);
    expect(shared.head(selected.conversation)).toEqual(selected);
    expect(shared.resolve(selected).messages).toHaveLength(1);
  });

  it('repairs omitted opening replies by attaching saved originals without rerunning them or partially publishing invalid selections', async () => {
    const first = 'CLAUDE_OPENING: Python is better.\nExact original argument.\n';
    const claude = fakeAgent({ script: (_p, turn) => [{ do: 'say', text: turn === 0 ? first : 'CLAUDE_REBUTTAL' }] });
    const codex = fakeAgent({ script: (_p, turn) => [{ do: 'say', text: turn === 0 ? 'CODEX_OPENING' : 'CODEX_REBUTTAL' }] });
    let initial!: SharedContextSelection, attached!: SharedContextSelection;
    const llm = model([
      () => step('agent', { agent: ['claude', 'codex'], kind: 'answer', prompt: 'Give independent opening positions.' }),
      () => step('shared_context', { operation: 'open', title: 'Recover the existing discussion' }),
      (m) => { initial = head(m); return step('shared_context', { operation: 'attach', conversation: initial.conversation, context_from: ['task:1', 'task:999'] }); },
      (m) => {
        expect(receipt(m)).toMatchObject({ status: 'error', created_tasks: [] });
        return step('shared_context', { operation: 'read', conversation: initial.conversation });
      },
      (m) => {
        expect(head(m)).toEqual(initial);
        expect(receipt(m).observed_tasks).toEqual([]);
        return step('shared_context', { operation: 'attach', conversation: initial.conversation, context_from: ['task:2', 'task:1', 'task:1'] });
      },
      (m) => {
        attached = head(m);
        expect(receipt(m)).toMatchObject({ created_tasks: [], observed_tasks: ['task:1', 'task:2'] });
        return worker(['claude', 'codex'], attached);
      }, finish,
    ]);
    const h = harness({ agents: { claude, codex }, llm }); opened.push(h);
    await h.runtime.conversation.send('ORIGINAL_USER_REQUEST: discuss both positions.');
    for (const participant of [claude, codex]) {
      expect(participant.prompts).toHaveLength(2);
      expect(participant.prompts[1]).toContain(first);
      expect(participant.prompts[1]).toContain('CODEX_OPENING');
      expect(participant.prompts[1]).toContain('ORIGINAL_USER_REQUEST');
    }
    expect(sharedPart(claude.prompts[1]!)).toBe(sharedPart(codex.prompts[1]!));
    const shared = new SharedConversations(h.runtime.transcript);
    expect(shared.resolve(initial).messages).toHaveLength(1);
    expect(shared.resolve(attached).messages.map((m) => [m.author, m.task])).toEqual([
      ['user', undefined], ['claude', 'task:1'], ['codex', 'task:2'],
    ]);
    const beforeRepeat = shared.head(initial.conversation);
    // Saving the same result again must not produce another contribution on reattachment.
    const original = h.runtime.transcript.all().find((r) => r.type === 'task_result' && r.taskId === 1)!;
    if (original.type !== 'task_result') throw new Error('Missing saved opening');
    h.runtime.transcript.append({ type: 'task_result', taskId: original.taskId, result: original.result });
    expect(shared.attach(initial.conversation, ['task:1', 'task:2'])).toEqual(beforeRepeat);
    expect(shared.resolve(attached).messages[1]!.content).toBe(first.trim());
    h.runtime.transcript.append({ type: 'clear' });
    const turn = h.runtime.transcript.append({ type: 'context', entry: { event: 'start', request: 'New boundary' } }).seq;
    const fresh = shared.open(turn, 'After clear');
    expect(() => shared.attach(fresh.conversation, ['task:1'])).toThrow('no saved task result');
    expect(shared.head(fresh.conversation)).toEqual(fresh);
  });

  it('waits for a pending session probe before opening a fresh session and keeps the selected model', async () => {
    const a = fakeAgent({ models: ['base', 'selected'], script: () => [] });
    const h = harness({ agents: { a }, config: { profiles: { a: { model: 'selected' } } } }); opened.push(h);
    const connection = await h.runtime.pool.connection('a');
    const newSession = connection.newSession.bind(connection);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(connection, 'newSession').mockImplementationOnce(async () => { await held; return newSession(); });
    const probe = h.runtime.pool.session('a');
    const rotation = h.runtime.pool.rotate('a');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeRelease = spy.mock.calls.length;
    release();
    const [previous, fresh] = await Promise.all([probe, rotation]);
    expect(beforeRelease).toBe(1);
    expect(fresh.sessionId).not.toBe(previous.sessionId);
    expect(h.runtime.pool.sessionId('a')).toBe(fresh.sessionId);
    expect(h.runtime.pool.currentModel('a')).toBe('selected');
  });

  it('delivers the complete same prefix to both participants across three fresh-session rounds', async () => {
    const first = `CLAUDE_1\n${'원문 근거를 보존합니다.\n'.repeat(1000)}`;
    const claude = fakeAgent({ script: (_p, turn) => [{ do: 'think', text: 'PRIVATE_REASONING' },
      { do: 'say', text: turn === 0 ? first : `CLAUDE_${turn + 1}` }] });
    const codex = fakeAgent({ script: (_p, turn) => [{ do: 'say', text: `CODEX_${turn + 1}` }] });
    let initial!: SharedContextSelection, second!: SharedContextSelection, third!: SharedContextSelection;
    const llm = model([
      () => step('shared_context', { operation: 'open', title: 'Language comparison' }),
      (messages) => { initial = head(messages); return worker(['claude', 'codex'], initial); },
      (messages) => { second = head(messages); return worker(['claude', 'codex'], second); },
      (messages) => { third = head(messages); return worker(['claude', 'codex'], third, { context_from: ['task:1'] }); },
      (messages) => step('shared_context', { operation: 'read', conversation: head(messages).conversation }),
      finish,
    ]);
    const h = harness({ agents: { claude, codex }, llm }); opened.push(h);
    await h.runtime.conversation.send('ORIGINAL_USER_REQUEST: 각자 첫 입장을 밝힌 뒤, 전체 대화를 읽고 세 번씩 발언해.');
    expect(claude.prompts).toHaveLength(3); expect(codex.prompts).toHaveLength(3);
    for (const participant of [claude, codex]) {
      expect(participant.prompts[0]).not.toContain(first);
      expect(participant.prompts[0]).not.toContain('CODEX_1');
      for (const prompt of participant.prompts.slice(1)) {
        expect(prompt).toContain(first);
        expect(prompt).toContain('CODEX_1');
        expect(prompt).toContain('ORIGINAL_USER_REQUEST');
        expect(prompt).not.toContain('PRIVATE_REASONING');
      }
      expect(participant.prompts[1]).not.toContain('CLAUDE_2');
      expect(participant.prompts[1]).not.toContain('CODEX_2');
      expect(participant.prompts[2]).toContain('CLAUDE_2');
      expect(participant.prompts[2]).toContain('CODEX_2');
      expect(participant.prompts[2]).not.toContain('CLAUDE_3');
      expect(participant.prompts[2]!.split(first)).toHaveLength(2); // No duplicate context_from attachment.
    }
    for (let round = 0; round < 3; round++) expect(sharedPart(claude.prompts[round]!)).toBe(sharedPart(codex.prompts[round]!));
    for (const [id, participant] of [['claude', claude], ['codex', codex]] as const) {
      for (const prompt of participant.prompts) {
        expect(prompt.startsWith(`You are the participant "${id}"`)).toBe(true);
        expect(prompt).toContain(`Reply only as "${id}"`);
        expect(prompt).toContain('identify the missing replies instead of inventing their arguments');
      }
    }
    const records = h.runtime.transcript.all();
    const calls = records.filter((record) => record.type === 'delegation');
    expect(new Set(calls.map((call) => `${call.agentId}:${call.sessionId}`)).size).toBe(6);
    expect(calls.map((call) => call.sharedContext)).toEqual([initial, initial, second, second, third, third]);
    const restored = new SharedConversations(h.runtime.transcript);
    expect(restored.resolve(initial).messages).toHaveLength(1);
    const snapshot = restored.resolve(restored.head(initial.conversation));
    expect(snapshot.messages.map((message) => message.author)).toEqual(['user', 'claude', 'codex', 'claude', 'codex', 'claude', 'codex']);
    const outcome = h.runtime.executor.readOutcome(5);
    expect(outcome.sharedContext).toEqual(third);
    expect(outcome.task).toBe('CURRENT_ASSIGNMENT: give your next response to the selected conversation.');
    expect(outcome.task).not.toContain(first);
    expect(receipt(llm.seen.at(-1)!)).toMatchObject({ created_tasks: [], observed_tasks: ['task:1', 'task:2', 'task:3', 'task:4', 'task:5', 'task:6'] });
  });

  it('lets a later call see the immediately preceding reply by selecting its returned head', async () => {
    const claude = fakeAgent({ script: (_p, turn) => [{ do: 'say', text: `CLAUDE_${turn + 1}` }] });
    const codex = fakeAgent({ script: (_p, turn) => [{ do: 'say', text: `CODEX_${turn + 1}` }] });
    const llm = model([
      () => step('shared_context', { operation: 'open', title: 'Sequential review' }),
      (m) => worker(['claude', 'codex'], head(m)),
      (m) => worker('claude', head(m)),
      (m) => worker('codex', head(m)), finish,
    ]);
    const h = harness({ agents: { claude, codex }, llm }); opened.push(h);
    await h.runtime.conversation.send('Give independent openings, then let Claude respond and Codex evaluate that response.');
    expect(codex.prompts[1]).toContain('CLAUDE_2');
    expect(codex.prompts[1]).toContain('CLAUDE_1');
    expect(codex.prompts[1]).toContain('CODEX_1');
  });

  it('rejects a record from another collaboration before starting a background job', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'SHOULD_NOT_RUN' }] });
    let first!: SharedContextSelection;
    const llm = model([
      () => step('shared_context', { operation: 'open', title: 'One' }),
      (m) => { first = head(m); return step('shared_context', { operation: 'open', title: 'Two' }); },
      (m) => worker('claude', { conversation: first.conversation, through: head(m).through }, { background: true }), finish,
    ]);
    const h = harness({ agents: { claude }, llm }); opened.push(h);
    await h.runtime.conversation.send('Separate these two collaborations.');
    expect(claude.prompts).toHaveLength(0);
    expect(h.runtime.transcript.all().filter((record) => record.type === 'agent_job')).toEqual([]);
    expect(receipt(llm.seen.at(-1)!)).toMatchObject({ status: 'error', executed: false, created_tasks: [], error: { code: 'invalid_shared_context' } });
  });

  it('records user steering and preserves older snapshots without applying the update retroactively', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'FIRST_REPLY' }] });
    const codex = fakeAgent({ script: () => [{ do: 'say', text: 'UPDATED_REPLY' }] });
    let initial!: SharedContextSelection;
    const llm = model([
      () => step('shared_context', { operation: 'open', title: 'Steered task' }),
      (m) => { initial = head(m); return worker('claude', initial); },
      () => step('shared_context', { operation: 'read', conversation: initial.conversation }),
      (m) => worker('codex', head(m)), finish,
    ]);
    const h = harness({ agents: { claude, codex }, llm }); opened.push(h);
    let update: Promise<void> | undefined;
    h.runtime.transcript.on('record', (record) => {
      if (record.type === 'delegation' && record.agentId === 'claude') update = h.runtime.conversation.send('USER_CORRECTION: 데이터 분석을 기준으로 비교해.');
    });
    await h.runtime.conversation.send('ORIGINAL_SCOPE: compare languages.'); await update;
    expect(claude.prompts[0]).not.toContain('USER_CORRECTION');
    expect(codex.prompts[0]).toContain('ORIGINAL_SCOPE');
    expect(codex.prompts[0]).toContain('USER_CORRECTION');
    expect(codex.prompts[0]).toContain('FIRST_REPLY');
    expect(new SharedConversations(h.runtime.transcript).resolve(initial).messages).toHaveLength(1);
  });

  it('continues a saved collaboration after restart without mixing in unrelated turns or relying on old sessions', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'SAVED_REPLY' }] });
    const b = fakeAgent({ script: () => [{ do: 'say', text: 'NEW_REPLY' }] });
    let selected!: SharedContextSelection;
    const first = harness({ agents: { a, b }, llm: model([
      () => step('shared_context', { operation: 'open', title: 'Preserved review' }),
      (m) => worker('a', head(m)), (m) => { selected = head(m); return finish(); }, finish,
    ]) }); opened.push(first);
    await first.runtime.conversation.send('ORIGINAL_SCOPE: review this design.');
    await first.runtime.conversation.send('UNRELATED_PRIVATE_TOPIC');
    await first.runtime.close();
    const resumed = harness({ agents: { a, b }, resume: { root: first.root, runId: first.runtime.workspace.id }, llm: model([
      () => step('shared_context', { operation: 'continue', conversation: selected.conversation }),
      (m) => worker('b', head(m)), finish,
    ]) }); opened.push(resumed);
    await resumed.runtime.conversation.send('FOLLOWUP_REQUEST: reconsider that review.');
    expect(b.prompts[0]).toContain('ORIGINAL_SCOPE');
    expect(b.prompts[0]).toContain('SAVED_REPLY');
    expect(b.prompts[0]).toContain('FOLLOWUP_REQUEST');
    expect(b.prompts[0]).not.toContain('UNRELATED_PRIVATE_TOPIC');
    expect(new SharedConversations(resumed.runtime.transcript).resolve(selected).messages).toHaveLength(2);
  });

  it('uses the explicitly selected snapshot for background follow-ups and publishes failed outcomes as such', async () => {
    const a = fakeAgent({ script: (_p, turn) => [{ do: 'say', text: turn === 0
      ? 'FAILED_EVIDENCE\n\nREPORT\noutcome: blocked\nsummary: A required input is missing.' : 'FOLLOWUP_EVIDENCE' }] });
    let selected!: SharedContextSelection, followup!: SharedContextSelection;
    const llm = model([
      () => step('shared_context', { operation: 'open', title: 'Background review' }),
      (m) => { selected = head(m); return worker('a', selected, { background: true }); },
      () => step('agent_job', { operation: 'wait', jobIds: ['job:1'] }),
      () => step('shared_context', { operation: 'read', conversation: selected.conversation }),
      (m) => { followup = head(m); return step('agent_job', { operation: 'followup', jobId: 'job:1', prompt: 'Evaluate the actual failure.' }); },
      (m) => {
        expect(receipt(m)).toMatchObject({ status: 'error', executed: false, error: { code: 'shared_context_required' } });
        return step('agent_job', { operation: 'followup', jobId: 'job:1', prompt: 'Evaluate the actual failure.', shared_context: followup });
      },
      () => step('agent_job', { operation: 'wait', jobIds: ['job:2'] }),
      () => step('agent_job', { operation: 'followup', jobId: 'job:2', prompt: 'An ordinary follow-up outside the scope.', shared_context: null }),
      () => step('agent_job', { operation: 'wait', jobIds: ['job:3'] }), finish,
    ]);
    const h = harness({ agents: { a }, llm }); opened.push(h);
    await h.runtime.conversation.send('Assess and follow up on the evidence.');
    expect(a.prompts).toHaveLength(3);
    expect(a.prompts[1]).toContain('FAILED_EVIDENCE');
    expect(a.prompts[1]).toContain('"status":"blocked"');
    expect(a.prompts[2]).not.toContain('SHARED CONVERSATION');
    const shared = new SharedConversations(h.runtime.transcript);
    expect(shared.resolve(shared.head(selected.conversation)).messages.map((message) => message.task).filter(Boolean)).toEqual(['task:1', 'task:2']);
  });

  it('keeps explicit orchestrator notes separate and rejects cleared scopes, including late publications', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'SOURCE_REPLY' }] });
    let selected!: SharedContextSelection;
    const h = harness({ agents: { a }, llm: model([
      () => step('shared_context', { operation: 'open', title: 'Original collaboration' }),
      (m) => worker('a', head(m)), (m) => { selected = head(m); return finish(); },
    ]) }); opened.push(h);
    await h.runtime.conversation.send('EXACT_USER_REQUEST');
    const shared = new SharedConversations(h.runtime.transcript);
    const withNote = shared.note(selected.conversation, 'ORCHESTRATOR_INTERPRETATION');
    expect(shared.resolve(withNote).messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'EXACT_USER_REQUEST' }, { role: 'agent', content: 'SOURCE_REPLY' },
      { role: 'orchestrator', content: 'ORCHESTRATOR_INTERPRETATION' },
    ]);
    expect(shared.resolve(selected).messages).toHaveLength(2);
    const result = h.runtime.transcript.all().find((record) => record.type === 'task_result')!;
    h.runtime.transcript.append({ type: 'clear' });
    shared.publish(selected.conversation, 1);
    h.runtime.transcript.append({ type: 'shared_context', entry: { event: 'reply',
      conversation: Number(selected.conversation.split(':')[1]), source: result.seq } });
    expect(shared.list()).toEqual([]);
    expect(() => shared.resolve(selected)).toThrow('No shared conversation');
    expect(new SharedConversations(h.runtime.transcript).list()).toEqual([]);
  });
});
