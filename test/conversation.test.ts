import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import { estimateTokens, type ChatClient } from '../src/brain/client.js';
import { buildView, describeRecord } from '../src/ui/view-model.js';

let open: Harness | undefined;

afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

const delegate = (task: string) =>
  JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', prompt: task } });
const answer = (message: string) => JSON.stringify({ action: 'answer', message });

function assistantText(h: Harness): string[] {
  return h.runtime.transcript
    .all()
    .filter((record) => record.type === 'assistant')
    .map((record) => (record.type === 'assistant' ? record.text : ''));
}

/** A scripted model that streams each reply through onDelta before returning it. */
function streamingModel(replies: string[]): ChatClient {
  let index = 0;
  return {
    async chat(_messages, options) {
      const reply = replies[index++];
      if (reply === undefined) throw new Error('scripted model has no reply left');
      for (let at = 0; at < reply.length; at += 5) {
        options?.onDelta?.(reply.slice(at, at + 5));
      }
      return reply;
    },
  };
}

describe('Conversation', () => {
  it('executes every recipient selected by the planner before accepting its answer', async () => {
    const agents = Object.fromEntries(['claude', 'gemini', 'codex'].map((id) => [id,
      fakeAgent({ script: () => [{ do: 'say', text: `Hello from ${id}` }] }),
    ]));
    const llm = scriptedModel([
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: Object.keys(agents), kind: 'answer', prompt: '하이?' } }),
      answer('세 에이전트 모두 응답했습니다.'),
    ]);
    const h = harness({ agents, llm });
    open = h;
    await h.runtime.conversation.send('모든 에이전트한테 하이?라고 물어봐');
    expect(llm.seen[0]?.at(-1)?.content).toContain('모든 에이전트한테');
    for (const [id, agent] of Object.entries(agents)) {
      expect(agent.prompts).toHaveLength(1);
      expect(agent.prompts[0]).toContain('하이?');
      expect(agent.prompts[0]).toContain('Do not create, modify or delete');
    }
    expect(h.runtime.transcript.all().filter((r) => r.type === 'task_result')).toHaveLength(3);
    expect(llm.seen).toHaveLength(2);
    for (const id of Object.keys(agents)) {
      expect(llm.seen[1]?.at(-1)?.content).toContain(id);
    }
    expect(assistantText(h).at(-1)).toBe('세 에이전트 모두 응답했습니다.');
    expect(buildView(h.runtime.transcript.all(), h.workspaceDir).at(-1)).toMatchObject({
      role: 'handsfree', text: '세 에이전트 모두 응답했습니다.',
    });
  });

  it('continues a selected group after an adapter fails', async () => {
    const failed = fakeAgent({ script: () => [{ do: 'fail', message: 'adapter failed' }] });
    const healthy = fakeAgent({ script: () => [{ do: 'say', text: 'Hello' }] });
    const llm = scriptedModel([
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: ['failed', 'healthy'], kind: 'answer', prompt: 'Hello?' } }),
      answer('healthy responded, but failed ended with an error.'),
    ]);
    const h = harness({ agents: { failed, healthy }, llm });
    open = h;
    await h.runtime.conversation.send('둘 다 인사해 줘');
    expect(healthy.prompts).toHaveLength(1);
    expect(assistantText(h).at(-1)).toContain('failed');
    expect(assistantText(h).at(-1)).toContain('healthy');
    const results = h.runtime.transcript.all().filter((r) => r.type === 'task_result');
    expect(results).toHaveLength(2);
    expect(results[0]?.result.status).not.toBe('done');
    expect(results[1]?.result.status).toBe('done');
    expect(llm.seen[1]?.at(-1)?.content).toContain('Task 1 (failed): error');
    expect(llm.seen[1]?.at(-1)?.content).toContain('Task 2 (healthy): done');
    expect(buildView(h.runtime.transcript.all(), h.workspaceDir).at(-1)).toMatchObject({
      role: 'handsfree', text: 'healthy responded, but failed ended with an error.',
    });
  });

  it('continues planning after a group and displays the final streamed answer', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'Hello from claude' }] });
    const gemini = fakeAgent({ script: () => [{ do: 'say', text: 'Hello from gemini' }] });
    const summary = 'Both agents replied, and claude answered the follow-up.';
    const llm = streamingModel([
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: ['claude', 'gemini'], kind: 'answer', prompt: 'Hi?' } }),
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', kind: 'answer', prompt: 'How are you?' } }),
      answer(summary),
    ]);
    const h = harness({ agents: { claude, gemini }, llm });
    open = h;

    await h.runtime.conversation.send('Say hi to both, then ask claude how it is.');

    expect(claude.prompts).toHaveLength(2);
    expect(claude.prompts[1]).toContain('How are you?');
    expect(gemini.prompts).toHaveLength(1);
    expect(assistantText(h).at(-1)).toBe(summary);
    const deltas = h.runtime.transcript.all().filter((r) => r.type === 'assistant_delta');
    expect(deltas.map((r) => r.text).join('')).toBe(summary);
    expect(buildView(h.runtime.transcript.all(), h.workspaceDir).filter((r) => r.text === summary)).toHaveLength(1);
  });

  it('narrates group results when the planning step limit is reached', async () => {
    const agents = Object.fromEntries(['claude', 'gemini'].map((id) => [id,
      fakeAgent({ script: () => [{ do: 'say', text: 'Hi' }] }),
    ]));
    const summary = 'claude and gemini both replied.';
    const llm = scriptedModel([
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: Object.keys(agents), kind: 'answer', prompt: 'Hi?' } }),
      summary,
    ]);
    const h = harness({ agents, llm, config: { limits: { maxPlanSteps: 1 } } });
    open = h;

    await h.runtime.conversation.send('Say hi to both agents.');

    expect(llm.seen).toHaveLength(2);
    expect(buildView(h.runtime.transcript.all(), h.workspaceDir).at(-1)).toMatchObject({
      role: 'handsfree', text: summary,
    });
  });

  it('charges grouped recipients against the remaining turn limit and names omissions', async () => {
    const agents = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, fakeAgent({ script: () => [{ do: 'say', text: 'Hi' }] })]));
    const h = harness({ agents, config: { limits: { maxDelegationsPerTurn: 2 } }, llm: scriptedModel([
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'a', kind: 'answer', prompt: 'Hi' } }),
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: ['b', 'c'], kind: 'answer', prompt: 'Hi' } }),
    ]) });
    open = h;
    await h.runtime.conversation.send('인사해 줘');
    expect(agents.a!.prompts).toHaveLength(1);
    expect(agents.b!.prompts).toHaveLength(1);
    expect(agents.c!.prompts).toHaveLength(0);
    expect(assistantText(h).at(-1)).toContain('Not contacted (delegation limit reached): c');
  });

  it('answers directly without touching an agent', async () => {
    const agent = fakeAgent({ script: () => [] });
    const h = harness({ agents: { claude: agent }, llm: scriptedModel([answer('Hi there.')]) });
    open = h;

    await h.runtime.conversation.send('hello');

    expect(assistantText(h)).toEqual(['Hi there.']);
    expect(agent.prompts).toEqual([]);
  });

  it('streams an answer while the model writes it', async () => {
    const agent = fakeAgent({ script: () => [] });
    const h = harness({ agents: { claude: agent }, llm: streamingModel([answer('Hi there.')]) });
    open = h;

    await h.runtime.conversation.send('hello');

    // The message field streamed as it was decoded, and the close settled it.
    const deltas = h.runtime.transcript
      .all()
      .filter((record) => record.type === 'assistant_delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((record) => record.text).join('')).toBe('Hi there.');
    expect(assistantText(h)).toEqual(['Hi there.']);
  });

  it('retracts what streamed from a reply that turned out unusable', async () => {
    const agent = fakeAgent({ script: () => [] });
    // The first reply streams half a message and never closes its JSON; the
    // retry answers properly.
    const llm = streamingModel(['{"action":"answer","message":"oops', answer('All good.')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('hello');

    const finals = h.runtime.transcript.all().filter((record) => record.type === 'assistant');
    // One retraction for the broken attempt, then the real answer.
    expect(finals.map((record) => record.text)).toEqual(['', 'All good.']);
    expect(assistantText(h).at(-1)).toBe('All good.');
  });

  it('delegates, then reports what the agent actually did', async () => {
    const agent = fakeAgent({
      script: () => [
        { do: 'tool', toolCallId: 't1', title: 'Write notes.txt', kind: 'edit' },
        { do: 'say', text: 'Created notes.txt.' },
      ],
    });
    const llm = scriptedModel([delegate('Create notes.txt'), answer('Created notes.txt for you.')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('make notes.txt');

    expect(agent.prompts[0]).toContain('Create notes.txt');
    expect(assistantText(h)).toEqual(['Created notes.txt for you.']);

    const kinds = h.runtime.transcript.all().map((record) => record.type);
    expect(kinds).toContain('delegation');
    expect(kinds).toContain('stop');
  });

  it('writes what the task cost on its stop, as the agent counted it', async () => {
    const agent = fakeAgent({
      script: () => [
        { do: 'say', text: 'Created notes.txt.' },
        { do: 'stop', reason: 'end_turn', usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 } },
      ],
    });
    const llm = scriptedModel([delegate('Create notes.txt'), answer('Done.')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('make notes.txt');

    const stop = h.runtime.transcript.all().find((record) => record.type === 'stop');
    expect(stop).toMatchObject({
      type: 'stop',
      agentId: 'claude',
      stopReason: 'end_turn',
      usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 },
    });
    // The planner's calls are written down under the planner's own name.
    const plans = h.runtime.transcript.all().filter((record) => record.type === 'usage' && record.purpose === 'plan');
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(plan).toMatchObject({ model: 'google/gemma-3-12b' });
    // The run's own output says so too, beside the stop reason.
    expect(describeRecord(stop!, h.workspaceDir)).toBe('← claude (end_turn, 1k tokens)');
  });

  it('writes the model a task ran on at its stop, so the spend can follow the model', async () => {
    const agent = fakeAgent({ models: ['opus', 'haiku'], script: () => [{ do: 'say', text: 'ok' }] });
    const llm = scriptedModel([delegate('one'), answer('one done')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('do one');
    // A mention moves the session to haiku, and the stop says so.
    await h.runtime.conversation.send('@claude:haiku do two');

    const stops = h.runtime.transcript.all().filter((record) => record.type === 'stop');
    expect(stops.map((stop) => (stop.type === 'stop' ? stop.model : undefined))).toEqual(['opus', 'haiku']);
  });

  it('asks an agent a question without asking it to build anything', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'say', text: '안녕하세요!' }] });
    const llm = scriptedModel([
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', kind: 'answer', prompt: '안녕?' } }),
      answer('claude says 안녕하세요!'),
    ]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('claude한테 안녕?이라고 물어봐');

    expect(agent.prompts[0]).toContain('안녕?');
    expect(agent.prompts[0]).toContain('Do not create, modify or delete any file');
    expect(assistantText(h)).toEqual(['claude says 안녕하세요!']);

    // The point of the answer kind: nothing was written to say it.
    const notes = h.runtime.transcript.all().filter((record) => record.type === 'note');
    expect(notes.map((note) => (note.type === 'note' ? note.text : ''))).not.toContainEqual(
      expect.stringContaining('wrote'),
    );
  });

  it('tells the agent the ground rules once, not on every task', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'say', text: 'ok' }] });
    const llm = scriptedModel([
      delegate('First task'),
      delegate('Second task'),
      answer('Both done.'),
    ]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('do two things');

    expect(agent.prompts[0]).toContain('handsfree approves or refuses');
    expect(agent.prompts[1]).not.toContain('handsfree approves or refuses');
    expect(agent.prompts[1]).toContain('Second task');
  });

  it('passes refusals back to the planner instead of hiding them', async () => {
    const agent = fakeAgent({
      script: () => [
        { do: 'ask', title: 'Edit /etc/hosts', kind: 'edit', locations: ['/etc/hosts'] },
        { do: 'say', text: 'I could not edit that file.' },
      ],
    });
    const llm = scriptedModel([delegate('Edit the hosts file'), answer('That was refused.')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('edit /etc/hosts');

    const observations = llm.seen
      .flat()
      .filter((message) => message.content.startsWith('TOOL RESULT (agent)'))
      .map((message) => message.content)
      .join('\n');
    expect(observations).toContain('refused');
    expect(observations).toContain('/etc/hosts');
  });

  it.each([false, true])('dispatches a retry with an empty work list using the current user decision (approved=%s)', async (enabled) => {
    const results: { ok: boolean; detail: string }[] = [];
    const agent = fakeAgent({ script: () => [
      { do: 'exec', command: 'echo', args: ['checked'], onResult: (result) => results.push(result) },
      { do: 'say', text: 'Attempt finished.' },
    ] });
    const task = '사용자가 다시 요청했습니다. 변경 사항을 다시 확인하고 파일은 수정하지 마세요.';
    const summary = enabled ? '클로드가 다시 확인했습니다.' : '클로드에게 다시 요청했지만 현재 명령 실행 설정에서 거부됐습니다.';
    const llm = scriptedModel([
      JSON.stringify({
        review: { objective: '변경 사항 재확인', constraints: ['파일 수정 금지'], completed: [], remaining: [], next: -1, blocker: '' },
        action: 'call', tool: 'agent', input: { agent: 'claude', kind: 'change', prompt: task },
      }),
      answer(summary),
    ]);
    const h = harness({ agents: { claude: agent }, llm, config: {} });
    open = h;

    await h.runtime.conversation.send('@claude 변경 사항 확인해');
    h.runtime.setEscalator({ ask: async () => enabled });
    await h.runtime.conversation.send('허용했어. 클로드한테 다시 요청하라고.');

    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toContain(task);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.ok)).toEqual([false, enabled]);
    expect(llm.seen).toHaveLength(2);
    const reviews = h.runtime.transcript.all().filter((r) => r.type === 'context' && r.entry.event === 'review');
    expect(reviews).toContainEqual(expect.objectContaining({ entry: expect.objectContaining({
      state: expect.objectContaining({ remaining: [task], next: 0 }),
    }) }));
    expect(assistantText(h).at(-1)).toBe(summary);
  });

  it('records recovered work as completed and prevents duplicate execution in the same turn', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'say', text: 'Checked.' }] });
    const task = 'Check the changes again';
    const call = JSON.stringify({
      review: { objective: task, constraints: [], completed: [], remaining: [], next: -1, blocker: '' },
      action: 'call', tool: 'agent', input: { agent: 'claude', kind: 'inspect', prompt: task },
    });
    const llm = scriptedModel([call, call, answer('Checked.')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('Ask Claude to check again');

    expect(agent.prompts).toHaveLength(1);
    expect(llm.seen[2]?.at(-1)?.content).toContain('has already executed successfully');
    expect(assistantText(h).at(-1)).toBe('Checked.');
  });

  it('stops at the delegation limit and still reports', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'say', text: 'ok' }] });
    const llm = scriptedModel([delegate('one'), delegate('two'), delegate('three')]);
    const h = harness({
      agents: { claude: agent },
      llm,
      config: { limits: { maxDelegationsPerTurn: 2 } },
    });
    open = h;

    await h.runtime.conversation.send('go');

    expect(agent.prompts).toHaveLength(2);
    expect(assistantText(h).at(-1)).toContain('limit of 2');
  });

  it('falls back to a ledger when the local model cannot be reached', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'say', text: 'done' }] });
    let calls = 0;
    const llm: ChatClient = {
      async chat() {
        calls++;
        if (calls === 1) return delegate('Create notes.txt');
        throw new Error('connection refused');
      },
    };
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('make notes.txt');

    const reply = assistantText(h).at(-1) ?? '';
    expect(reply).toContain('Task 1 (claude): done');
    expect(reply).toContain('did not produce a usable next step');
  });

  it('reports plainly when an agent cannot be started', async () => {
    // What a missing or broken adapter looks like from the host's side.
    const unavailable = {
      app: undefined as never,
      prompts: [],
      modelSets: [],
      seen: () => undefined,
      target: () => ({
        description: 'broken adapter',
        connect(): never {
          throw new Error('adapter not installed');
        },
        close: async () => {},
      }),
    };
    const h = harness({
      agents: { claude: unavailable },
      llm: scriptedModel([delegate('Create notes.txt')]),
    });
    open = h;

    // The TUI's roster probe asks for the session while the task does, and
    // both wait on the one attempt.
    const probe = h.runtime.pool.session('claude').catch((err: unknown) => (err as Error).message);
    await h.runtime.conversation.send('make notes.txt');

    const reply = assistantText(h).at(-1) ?? '';
    expect(reply).toContain('adapter not installed');
    expect(reply).not.toContain('done');
    expect(await probe).toContain('adapter not installed');
    // One failure, one line on the record — however many were waiting on it.
    const errors = h.runtime.transcript
      .all()
      .filter((record) => record.type === 'note' && record.level === 'error');
    expect(errors).toHaveLength(1);
  });

  it('discards a summary that does not report the work', async () => {
    const agent = fakeAgent({
      script: () => [
        {
          do: 'tool',
          toolCallId: 't1',
          title: 'Write notes.txt',
          kind: 'edit',
          locations: ['/tmp/notes.txt'],
        },
      ],
    });
    // What gemma-3-12b actually replies when asked to summarise a finished task.
    const llm = scriptedModel([delegate('Create notes.txt'), "Great! What's next?"]);
    // One step, so the reply after the task is the summary rather than a plan.
    const h = harness({ agents: { claude: agent }, llm, config: { limits: { maxPlanSteps: 1 } } });
    open = h;

    await h.runtime.conversation.send('make notes.txt');

    const reply = assistantText(h).at(-1) ?? '';
    expect(reply).not.toBe("Great! What's next?");
    expect(reply).toContain('Task 1 (claude): done');
  });

  it('keeps a summary that tells the work in its own words, naming nobody', async () => {
    // The task ran a command and touched no file; the narrator said what
    // happened without naming claude, "done" or a path. That is a report.
    const agent = fakeAgent({
      script: () => [{ do: 'say', text: 'REPORT\noutcome: done\nsummary: Ran the tokenize tests; all nine passed.' }],
    });
    const llm = scriptedModel([
      delegate('Run the tokenize tests and report the count'),
      'The tokenize tests were executed and all nine passed. Nothing was changed.',
    ]);
    const h = harness({ agents: { claude: agent }, llm, config: { limits: { maxPlanSteps: 1 } } });
    open = h;

    await h.runtime.conversation.send('run the tests');

    expect(assistantText(h).at(-1)).toBe('The tokenize tests were executed and all nine passed. Nothing was changed.');
  });

  it('marks a reply that is the ledger, so the view can hang it on the agent', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'say', text: 'ok' }] });
    const llm = scriptedModel([delegate('Create notes.txt'), "Great! What's next?"]);
    const h = harness({ agents: { claude: agent }, llm, config: { limits: { maxPlanSteps: 1 } } });
    open = h;

    await h.runtime.conversation.send('make notes.txt');

    const reply = h.runtime.transcript.all().filter((record) => record.type === 'assistant').at(-1);
    expect(reply).toMatchObject({ ledger: true });
    expect(reply && reply.type === 'assistant' ? reply.text : '').toContain('Task 1 (claude): done');
  });

  it('keeps a summary that does report the work', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'say', text: 'ok' }] });
    const llm = scriptedModel([delegate('Create notes.txt'), 'claude created the file.']);
    const h = harness({ agents: { claude: agent }, llm, config: { limits: { maxPlanSteps: 1 } } });
    open = h;

    await h.runtime.conversation.send('make notes.txt');

    expect(assistantText(h).at(-1)).toBe('claude created the file.');
  });

  it('shuts down mid-turn without waiting on the model to summarise', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'stall', ms: 10_000 }] });
    let calls = 0;
    const llm: ChatClient = {
      async chat() {
        calls++;
        if (calls === 1) return delegate('Sleep forever');
        // What /exit used to hang on: a summary request nothing can abort.
        return new Promise<never>(() => {});
      },
    };
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    const turn = h.runtime.conversation.send('sleep');
    while (!h.runtime.transcript.all().some((record) => record.type === 'delegation')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await h.runtime.close();
    await turn;

    // No summary was asked of the model, and none was written: a cancelled
    // turn ends silently.
    expect(calls).toBe(1);
    expect(assistantText(h)).toEqual([]);
  });

  it.each([false, true])('ends a cancelled turn silently (group: %s)', async (group) => {
    const agent = fakeAgent({ script: () => [{ do: 'stall', ms: 10_000 }] });
    let calls = 0;
    const llm: ChatClient = {
      async chat() {
        calls++;
        if (calls === 1) return group
          ? JSON.stringify({ action: 'call', tool: 'agent', input: { agent: ['claude', 'gemini'], kind: 'answer', prompt: 'Sleep forever' } })
          : delegate('Sleep forever');
        throw new Error('a cancelled turn must not ask the model anything');
      },
    };
    const gemini = fakeAgent({ script: () => [{ do: 'say', text: 'Hi' }] });
    const h = harness({ agents: { claude: agent, gemini }, llm });
    open = h;

    const turn = h.runtime.conversation.send('sleep');
    while (!h.runtime.transcript.all().some((record) => record.type === 'delegation')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    h.runtime.conversation.cancel();
    await turn;

    // The stop is on the record; the user just isn't answered about it.
    expect(calls).toBe(1);
    expect(assistantText(h)).toEqual([]);
    expect(h.runtime.transcript.all().map((record) => record.type)).toContain('stop');
    expect(gemini.prompts).toHaveLength(0);
  });

  it('routes a leading @mention straight to its agent, planner unconsulted', async () => {
    const claude = fakeAgent({ script: () => [] });
    const gemini = fakeAgent({ script: () => [{ do: 'say', text: 'made it.' }] });
    // No reply scripted: a planner asked anything would run the script dry.
    const llm = scriptedModel([]);
    const h = harness({ agents: { claude, gemini }, llm });
    open = h;

    await h.runtime.conversation.send('@gemini make notes.txt');

    expect(gemini.prompts[0]).toContain('make notes.txt');
    expect(gemini.prompts[0]).not.toContain('@gemini');
    expect(claude.prompts).toEqual([]);
    // Not for the summary either: the user watched the one task they routed,
    // so the turn closes on the ledger the moment the agent stops.
    expect(llm.seen).toHaveLength(0);
    const reply = h.runtime.transcript.all().filter((record) => record.type === 'assistant').at(-1);
    expect(reply).toMatchObject({ ledger: true });
    expect(assistantText(h).at(-1)).toContain('Task 1 (gemini): done');

    const kinds = h.runtime.transcript.all().map((record) => record.type);
    expect(kinds).toContain('delegation');
    expect(kinds).toContain('stop');
  });

  it('leaves an agent on the model it came up on when the profile asks for none', async () => {
    // The common case now: the adapter is the CLI's own, so its default is the
    // CLI's default and handsfree has no business moving it.
    const codex = fakeAgent({
      models: ['gpt-5.6-terra', 'gpt-5.5'],
      script: () => [{ do: 'say', text: 'done.' }],
    });
    const llm = scriptedModel([answer('done.')]);
    const h = harness({ agents: { codex }, llm });
    open = h;

    await h.runtime.conversation.send('@codex make notes.txt');

    expect(codex.modelSets).toEqual([]);
    expect(codex.prompts).toHaveLength(1);
    expect(h.runtime.pool.currentModel('codex')).toBe('gpt-5.6-terra');
  });

  it("puts a session on the profile's model when one disagrees with the agent", async () => {
    const codex = fakeAgent({
      models: ['gpt-5.6-terra', 'gpt-5.5'],
      script: () => [{ do: 'say', text: 'done.' }],
    });
    const llm = scriptedModel([answer('done.')]);
    const h = harness({
      agents: { codex },
      llm,
      config: { profiles: { codex: { model: 'gpt-5.5' } } },
    });
    open = h;

    await h.runtime.conversation.send('@codex make notes.txt');

    // Moved as the session opened, before the prompt reached it.
    expect(codex.modelSets).toEqual(['gpt-5.5']);
    expect(codex.prompts).toHaveLength(1);
    expect(h.runtime.pool.currentModel('codex')).toBe('gpt-5.5');
  });

  it('sets the model a :suffix asks for before the task is sent', async () => {
    const gemini = fakeAgent({
      models: ['gemini-3.5-flash', 'gemini-3.5-pro'],
      script: () => [{ do: 'say', text: 'done.' }],
    });
    const llm = scriptedModel([answer('done on pro.')]);
    const h = harness({ agents: { gemini }, llm });
    open = h;

    await h.runtime.conversation.send('@gemini:pro make notes.txt');

    // The switch landed before the prompt, and the record says what ran where.
    expect(gemini.modelSets).toEqual(['gemini-3.5-pro']);
    expect(gemini.prompts[0]).toContain('make notes.txt');
    const delegation = h.runtime.transcript
      .all()
      .find((record) => record.type === 'delegation');
    expect(delegation).toMatchObject({ agentId: 'gemini', model: 'gemini-3.5-pro' });
    expect(describeRecord(delegation!, h.workspaceDir)).toContain('gemini:gemini-3.5-pro');
  });

  it('routes a model id spelled with brackets, the way a variant is named', async () => {
    // claude-agent-acp advertises `opus[1m]`; the brackets are part of the id
    // and have to survive both the mention parser and the switch.
    const claude = fakeAgent({
      models: ['default', 'opus[1m]', 'sonnet'],
      script: () => [{ do: 'say', text: 'done.' }],
    });
    const llm = scriptedModel([answer('done on opus.')]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('@claude:opus[1m] 하이?');

    expect(claude.modelSets).toEqual(['opus[1m]']);
    expect(claude.prompts[0]).toContain('하이?');
    const delegation = h.runtime.transcript
      .all()
      .find((record) => record.type === 'delegation');
    expect(delegation).toMatchObject({ agentId: 'claude', model: 'opus[1m]' });
  });

  it('speaks the draft set_model dialect, for the adapters still on it', async () => {
    const gemini = fakeAgent({
      models: ['auto', 'gemini-3.5-flash', 'gemini-2.5-pro'],
      modelWire: 'set_model',
      script: () => [{ do: 'say', text: 'done.' }],
    });
    const llm = scriptedModel([answer('done on flash.'), answer('done again.')]);
    const h = harness({ agents: { gemini }, llm });
    open = h;

    await h.runtime.conversation.send('@gemini:flash fix the tests');
    await h.runtime.conversation.send('@gemini:flash one more pass');

    // Switched once over session/set_model, and remembered: the dialect sends
    // no confirmation, so not re-sending is what proves the state was kept.
    expect(gemini.modelSets).toEqual(['gemini-3.5-flash']);
    expect(gemini.prompts).toHaveLength(2);
  });

  it('matches a name the way it is typed: the id exactly, then as a prefix, then anywhere', async () => {
    const gemini = fakeAgent({
      models: ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'],
      script: () => [{ do: 'say', text: 'done.' }],
    });
    const llm = scriptedModel([answer('done.'), answer('done.')]);
    const h = harness({ agents: { gemini }, llm });
    open = h;

    await h.runtime.conversation.send('@gemini:lite make notes.txt');
    await h.runtime.conversation.send('@gemini:GEMINI-2 touch it up');

    expect(gemini.modelSets).toEqual(['gemini-3.1-flash-lite', 'gemini-2.5-pro']);
  });

  it('refuses to guess between two names a query fits', async () => {
    const gemini = fakeAgent({
      models: ['gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
      script: () => [{ do: 'say', text: 'never reached.' }],
    });
    const llm = scriptedModel([answer('which flash?')]);
    const h = harness({ agents: { gemini }, llm });
    open = h;

    await h.runtime.conversation.send('@gemini:flash make notes.txt');

    expect(gemini.prompts).toEqual([]);
    const note = h.runtime.transcript
      .all()
      .find((record) => record.type === 'note' && record.level === 'error');
    expect(note && note.type === 'note' ? note.text : '').toContain('could be any of');
  });

  it('fails the routing, prompt unsent, when the agent offers no such model', async () => {
    const gemini = fakeAgent({
      models: ['gemini-3.5-flash'],
      script: () => [{ do: 'say', text: 'never reached.' }],
    });
    const llm = scriptedModel([answer('that model is not offered.')]);
    const h = harness({ agents: { gemini }, llm });
    open = h;

    await h.runtime.conversation.send('@gemini:turbo make notes.txt');

    expect(gemini.prompts).toEqual([]);
    expect(gemini.modelSets).toEqual([]);
    // The error names the roster, because the user typed blind.
    const note = h.runtime.transcript
      .all()
      .find((record) => record.type === 'note' && record.level === 'error');
    expect(note && note.type === 'note' ? note.text : '').toContain('gemini-3.5-flash');
  });

  it('tells the user an agent that advertises no roster cannot be re-modelled', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'never reached.' }] });
    const llm = scriptedModel([answer('claude offers no model choice.')]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('@claude:opus fix it');

    expect(claude.prompts).toEqual([]);
    const note = h.runtime.transcript
      .all()
      .find((record) => record.type === 'note' && record.level === 'error');
    expect(note && note.type === 'note' ? note.text : '').toContain('no model selection over ACP');
  });

  it('fails loudly when a profile names a model its agent will not take', async () => {
    // The session cannot be put where the profile asks, so no task runs on a
    // model nobody chose.
    const claude = fakeAgent({
      models: ['default', 'sonnet'],
      script: () => [{ do: 'say', text: 'never reached.' }],
    });
    const llm = scriptedModel([answer('claude could not be started.')]);
    const h = harness({
      agents: { claude },
      llm,
      config: { profiles: { claude: { model: 'opus' } } },
    });
    open = h;

    await h.runtime.conversation.send('@claude fix it');

    expect(claude.prompts).toEqual([]);
    const note = h.runtime.transcript
      .all()
      .find((record) => record.type === 'note' && record.level === 'error');
    expect(note && note.type === 'note' ? note.text : '').toContain('no model matching "opus"');
  });

  it('leaves an @name nobody answers to for the planner to read', async () => {
    const claude = fakeAgent({ script: () => [] });
    const llm = scriptedModel([answer('nobody here goes by that name.')]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('@nobody do something');

    // The planner was consulted, and saw the line as it was typed.
    expect(llm.seen).toHaveLength(1);
    expect(llm.seen[0]?.some((message) => message.content.endsWith('\n---\n@nobody do something'))).toBe(true);
    expect(assistantText(h)).toEqual(['nobody here goes by that name.']);
  });

  it('hands an agent what the others changed since it last worked', async () => {
    let edited = '';
    const claude = fakeAgent({
      script: () => [
        {
          do: 'tool',
          toolCallId: 't1',
          title: 'Write a.ts',
          kind: 'edit',
          locations: [edited],
        },
        { do: 'say', text: 'Added parse(); empty input returns null.' },
      ],
    });
    const gemini = fakeAgent({ script: () => [{ do: 'say', text: 'Wrote three tests.' }] });
    const llm = scriptedModel([answer('done.'), answer('done.')]);
    const h = harness({
      agents: { claude, gemini },
      llm,
      config: { roles: { claude: 'general coding agent' } },
    });
    open = h;
    edited = path.join(h.workspaceDir, 'a.ts');

    await h.runtime.conversation.send('@claude add parse()');
    await h.runtime.conversation.send('@gemini test parse()');

    // gemini is told what claude changed, and what claude said about it —
    // paths and an account, not the file.
    expect(gemini.prompts[0]).toContain('Since your last task:');
    expect(gemini.prompts[0]).toContain('claude (general coding agent), task 1: changed a.ts');
    expect(gemini.prompts[0]).toContain('empty input returns null');
  });

  it("does not hand an agent back its own work, which its session remembers", async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'Added parse().' }] });
    const llm = scriptedModel([answer('done.'), answer('done.')]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('@claude add parse()');
    await h.runtime.conversation.send('@claude now tidy it');

    expect(claude.prompts[1]).not.toContain('Since your last task:');
    expect(claude.prompts[1]).not.toContain('Added parse().');
  });

  it('briefs an agent again once its session has run enough tasks to have compacted', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'ok' }] });
    const llm = scriptedModel([answer('a'), answer('b'), answer('c')]);
    const h = harness({
      agents: { claude },
      llm,
      config: { limits: { rebriefEveryTasks: 2 } },
    });
    open = h;

    await h.runtime.conversation.send('@claude one');
    await h.runtime.conversation.send('@claude two');
    await h.runtime.conversation.send('@claude three');

    expect(claude.prompts[0]).toContain('handsfree approves or refuses');
    expect(claude.prompts[1]).not.toContain('handsfree approves or refuses');
    // Two tasks on from the rules, so they go out again.
    expect(claude.prompts[2]).toContain('handsfree approves or refuses');
  });

  it('briefs an agent again after a turn that ran out of tokens', async () => {
    const claude = fakeAgent({
      script: (_prompt, turn) => (turn === 0 ? [{ do: 'stop', reason: 'max_tokens' }] : [{ do: 'say', text: 'ok' }]),
    });
    const llm = scriptedModel([answer('a'), answer('b')]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('@claude one');
    await h.runtime.conversation.send('@claude two');

    expect(claude.prompts[1]).toContain('handsfree approves or refuses');
  });

  it('keeps the run ahead of the user\'s line and folds the turn that established it', async () => {
    // Resolved once the harness exists, so the path is inside the real
    // workspace and the run state can name it the way a reader would.
    let edited = '';
    const claude = fakeAgent({
      script: () => [
        { do: 'tool', toolCallId: 't1', title: 'Write a.ts', kind: 'edit', locations: [edited] },
        { do: 'say', text: 'A long account of everything that was done, at length.' },
      ],
    });
    const llm = scriptedModel([delegate('Add parse()'), answer('done.'), answer('and again.')]);
    const h = harness({ agents: { claude }, llm });
    open = h;
    edited = path.join(h.workspaceDir, 'a.ts');

    await h.runtime.conversation.send('add parse()');
    await h.runtime.conversation.send('anything else?');

    const first = llm.seen[0] ?? [];
    const second = llm.seen.at(-1) ?? [];
    // The task is ahead of the new line, rebuilt from the record, with the
    // user's own words after the divider...
    const last = second.at(-1)?.content ?? '';
    expect(last).toContain('RUN STATE');
    expect(last).toContain('Task 1 (claude): done');
    expect(last).toContain('Files changed this run: a.ts');
    expect(last.endsWith('\n---\nanything else?')).toBe(true);
    // ...the system prompt is the one the first turn had, byte for byte, so an
    // endpoint that caches by prefix keeps it...
    expect(second[0]?.content).toBe(first[0]?.content);
    expect(second[0]?.content).not.toContain('Task 1');
    // ...and the turn that produced it is two messages, not five — the line
    // as typed, without the run state that went out ahead of it.
    expect(second.slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[1]?.content).toBe('add parse()');
    expect(second.some((message) => message.content.startsWith('TOOL RESULT (agent)'))).toBe(false);
    // What the agent said survives in one place only: as the task's "said"
    // line in the run state, not as a message of its own.
    expect(JSON.stringify(second.slice(0, -1))).not.toContain('A long account');
    expect(last).toContain('  said: A long account of everything that was done, at length.');
  });

  it('keeps what an agent said in the run state once the turn that asked has folded', async () => {
    const claude = fakeAgent({
      script: () => [
        {
          do: 'say',
          text:
            'TypeScript는 JavaScript의 상위 집합으로, 정적 타이핑을 더한 언어입니다. (at length)\n\n' +
            'REPORT\noutcome: done\nsummary: TS는 정적 타입을 더한 JS의 상위 집합.',
        },
      ],
    });
    const llm = scriptedModel([
      delegate('TS와 JS의 차이점을 설명해 줘'),
      answer('claude가 차이점을 정리했습니다. 더 알고 싶으신가요?'),
      answer('네, 이어서 설명하겠습니다.'),
    ]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('차이점이 뭐야?');
    await h.runtime.conversation.send('응');

    const last = llm.seen.at(-1) ?? [];
    // The turn folded to the line and the closing sentence: the result is gone...
    expect(last.some((message) => message.content.startsWith('TOOL RESULT (agent)'))).toBe(false);
    expect(JSON.stringify(last)).not.toContain('at length');
    // ...but what the agent said it said is ahead of the new line, so a "yes"
    // has something to be a yes to.
    const line = last.at(-1)?.content ?? '';
    expect(line).toContain('  task: TS와 JS의 차이점을 설명해 줘\n  said: TS는 정적 타입을 더한 JS의 상위 집합.');
    expect(line.endsWith('\n---\n응')).toBe(true);
  });

  it('preserves a group conversation and retrieves omitted details for follow-up questions', async () => {
    const detail = 'claude mentioned uncommitted changes in conversation.ts and conversation.test.ts.';
    const agents = {
      claude: fakeAgent({ script: () => [{ do: 'say', text: `Hello. ${detail}\n\nREPORT\noutcome: done\nsummary: Greeted the user.` }] }),
      gemini: fakeAgent({ script: () => [{ do: 'say', text: 'Hello from gemini' }] }),
      codex: fakeAgent({ script: () => [{ do: 'say', text: 'Hello from codex' }] }),
    };
    const llm = scriptedModel([
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: Object.keys(agents), kind: 'answer', prompt: '안녕?' } }),
      answer('세 에이전트 모두 응답했습니다.'),
      JSON.stringify({ action: 'call', tool: 'task_result', input: { taskId: 1 } }),
      answer(detail),
      answer('Claude만 수정 중인 파일을 언급했고, 나머지 둘은 인사만 했습니다.'),
    ]);
    const h = harness({ agents, llm });
    open = h;

    await h.runtime.conversation.send('모든 에이전트에게 "안녕?"이라고 물어봐');
    await h.runtime.conversation.send('특이사항은?');
    await h.runtime.conversation.send('특이 사항이 뭐냐고.');

    const followup = llm.seen[2] ?? [];
    expect(followup[1]?.content).toBe('모든 에이전트에게 "안녕?"이라고 물어봐');
    expect(followup[2]?.content).toContain('세 에이전트 모두 응답했습니다.');
    expect(followup.at(-1)?.content).toContain('Task 1 (claude): done');
    expect(followup.at(-1)?.content.endsWith('특이사항은?')).toBe(true);
    // The report omitted this detail, but reading the saved result recovers it.
    expect(JSON.stringify(followup)).not.toContain(detail);
    expect(llm.seen[3]?.at(-1)?.content).toContain(detail);
    const correction = llm.seen[4] ?? [];
    expect(correction.some((message) => message.role === 'user' && message.content === '특이사항은?')).toBe(true);
    expect(correction.some((message) => message.role === 'assistant' && message.content.includes(detail))).toBe(true);
    for (const agent of Object.values(agents)) expect(agent.prompts).toHaveLength(1);
    expect(assistantText(h).at(-1)).toBe('Claude만 수정 중인 파일을 언급했고, 나머지 둘은 인사만 했습니다.');
  });

  it('hands the planner a report with a way to retrieve the rest', async () => {
    const claude = fakeAgent({
      script: () => [
        {
          do: 'say',
          text:
            'Here is a long explanation of everything I did, at great length.\n\n' +
            'REPORT\noutcome: done\nsummary: Added parse() with a null return for empty input.\n' +
            'changed: a.ts\ndecided: - empty input returns null, not an error\n' +
            'open: - the CLI still passes undefined sometimes\nverify: pnpm test',
        },
      ],
    });
    const llm = scriptedModel([delegate('Add parse()'), answer('done.')]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('add parse()');

    const result = llm.seen[1]?.at(-1)?.content ?? '';
    expect(result.startsWith('TOOL RESULT (agent)')).toBe(true);
    expect(result).toContain('summary: Added parse() with a null return for empty input.');
    expect(result).toContain('open: the CLI still passes undefined sometimes');
    expect(result).toContain('use task_result for details');
    // What is for the next agent stays out of the planner's way, and so does the prose.
    expect(result).not.toContain('decided');
    expect(result).not.toContain('pnpm test');
    expect(result).not.toContain('great length');

    // The count is of what the tool relayed: the result under the heading.
    const relayed = result.slice(result.indexOf('\n') + 1);
    const usage = h.runtime.transcript
      .all()
      .find((record) => record.type === 'usage' && record.purpose === 'task');
    expect(usage).toMatchObject({ taskId: 1, relayedChars: relayed.length });
    expect(usage && usage.type === 'usage' ? usage.promptChars : 0).toBeGreaterThan(0);
  });

  it('hands the planner the whole reply when the config asks for it', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'The whole reply, verbatim.' }] });
    const llm = scriptedModel([delegate('Say something'), answer('done.')]);
    const h = harness({ agents: { claude }, llm, config: { orchestration: { relayAnswers: true } } });
    open = h;

    await h.runtime.conversation.send('say something');

    const result = llm.seen[1]?.at(-1)?.content ?? '';
    expect(result).toContain('The whole reply, verbatim.');
    expect(result).not.toContain('already seen');
  });

  it('sends the agent the brief as the planner wrote it, and records its title', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'ok' }] });
    const llm = scriptedModel([
      JSON.stringify({
        action: 'call',
        tool: 'agent',
        input: {
          agent: 'claude',
          description: 'rename the flag',
          prompt: 'Rename the flag. The user wants it called --strict, not --pedantic.',
        },
      }),
      answer('done.'),
    ]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('rename it');

    expect(claude.prompts[0]?.startsWith('Rename the flag. The user wants it called --strict, not --pedantic.')).toBe(true);
    const delegation = h.runtime.transcript.all().find((record) => record.type === 'delegation');
    expect(delegation).toMatchObject({ title: 'rename the flag', task: expect.stringContaining('Rename the flag') });
  });

  it('sends a planner that calls a tool it does not have, or an input the tool refuses, back for another try', async () => {
    const claude = fakeAgent({ script: () => [{ do: 'say', text: 'ok' }] });
    const llm = scriptedModel([
      JSON.stringify({ action: 'call', tool: 'shout', input: { text: 'x' } }),
      JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', prompt: '' } }),
      delegate('Do it'),
      answer('done.'),
    ]);
    const h = harness({ agents: { claude }, llm, config: { orchestration: { maxRepairAttempts: 3 } } });
    open = h;

    await h.runtime.conversation.send('do it');

    const corrections = llm.seen.map((messages) => messages.at(-1)?.content ?? '');
    expect(corrections[1]).toContain('"shout" is not a tool. Tools: agent');
    expect(corrections[2]).toContain('Input for "agent" does not match: "prompt"');
    expect(claude.prompts).toHaveLength(1);
  });

  it('drops the oldest turns first when the planner is over budget', async () => {
    const claude = fakeAgent({ script: () => [] });
    const llm = scriptedModel([answer('warmup'), answer('one'), answer('two'), answer('three'), answer('four')]);
    let fixed = 0;
    const measured: ChatClient = { async chat(messages, options) {
      fixed = estimateTokens(messages[0]?.content ?? '') + estimateTokens(JSON.stringify(options?.schema?.schema ?? {}));
      return llm.chat(messages, options);
    } };
    // Room for the instructions and current request, but not all four turns.
    const h = harness({
      agents: { claude },
      llm: measured,
      config: { orchestration: { maxOutputTokens: 128 } },
    });
    open = h;

    const line = 'a line of conversation that takes up room '.repeat(100);
    await h.runtime.conversation.send('warmup');
    h.runtime.config.orchestration.contextBudgetTokens = fixed + estimateTokens(line) + 400;
    await h.runtime.conversation.send(`${line}1`);
    await h.runtime.conversation.send(`${line}2`);
    await h.runtime.conversation.send(`${line}3`);
    await h.runtime.conversation.send(`${line}4`);

    const last = llm.seen.at(-1) ?? [];
    // The system prompt stays, the newest line stays, and what was dropped
    // was dropped from the front — whole turns, so a user line always leads.
    expect(last[0]?.role).toBe('system');
    expect(last.at(-1)?.content.endsWith('4')).toBe(true);
    expect(last.length).toBeLessThan(8);
    expect(last[1]?.role).toBe('user');
    expect(last.some((message) => message.content.endsWith('1'))).toBe(false);
  });

  it('writes down what each call to the planner cost', async () => {
    const agent = fakeAgent({ script: () => [] });
    const h = harness({ agents: { claude: agent }, llm: scriptedModel([answer('Hi.')]) });
    open = h;

    await h.runtime.conversation.send('hello');

    const usage = h.runtime.transcript.all().filter((record) => record.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ purpose: 'plan' });
    expect(usage[0] && usage[0].type === 'usage' ? usage[0].promptChars : 0).toBeGreaterThan(0);
  });

  it('offers the planner each agent\'s role and what its session already holds', async () => {
    let edited = '';
    const claude = fakeAgent({
      script: () => [
        { do: 'tool', toolCallId: 't1', title: 'Write a.ts', kind: 'edit', locations: [edited] },
        { do: 'say', text: 'done.' },
      ],
    });
    const gemini = fakeAgent({ script: () => [{ do: 'say', text: 'done.' }] });
    const llm = scriptedModel([answer('done.'), answer('done.')]);
    const h = harness({
      agents: { claude, gemini },
      llm,
      config: { roles: { claude: 'strong at multi-file edits', gemini: 'fast on single files' } },
    });
    open = h;
    edited = path.join(h.workspaceDir, 'a.ts');

    await h.runtime.conversation.send('@claude add parse()');
    await h.runtime.conversation.send('what next?');

    const last = llm.seen.at(-1) ?? [];
    const system = last[0]?.content ?? '';
    const state = last.at(-1)?.content ?? '';
    // The role says what each is for, in the part that never changes...
    expect(system).toContain('"claude": strong at multi-file edits');
    expect(system).toContain('"gemini": fast on single files');
    // ...and the record, in the part that does, says which one would not
    // have to read the file again.
    expect(state).toContain('- claude: 1 task this run; previously saw a.ts');
    // An agent that has done nothing is described, not annotated.
    expect(state).not.toContain('- gemini:');
  });

  it('leaves the history empty when a clear lands in the middle of a turn', async () => {
    // `/clear` never queues behind a turn, so this sequence is reachable: the
    // agent is still working when the slate is wiped.
    const agent = fakeAgent({ script: () => [{ do: 'stall', ms: 60 }, { do: 'say', text: 'done' }] });
    const llm = scriptedModel([delegate('Sleep on it'), answer('all done.'), answer('fresh start.')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    const turn = h.runtime.conversation.send('take your time');
    while (!h.runtime.transcript.all().some((record) => record.type === 'delegation')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await h.runtime.conversation.send('/clear');
    await turn;

    await h.runtime.conversation.send('hello again');

    const after = llm.seen.at(-1) ?? [];
    // The cleared conversation is a system prompt and one line, not the
    // wreckage of a turn that outlived it — and never two users in a row.
    expect(after.map((message) => message.role)).toEqual(['system', 'user']);
    expect(after[1]?.content.endsWith('\n---\nhello again')).toBe(true);
    expect(after[1]?.content).not.toContain('task 1');
    expect(after[1]?.content).not.toContain('Task 1');
  });

  it('briefs an agent from scratch after a clear that landed mid-task', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'stall', ms: 60 }, { do: 'say', text: 'done' }] });
    const llm = scriptedModel([delegate('Sleep on it'), answer('all done.'), answer('ok.')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    const turn = h.runtime.conversation.send('take your time');
    while (!h.runtime.transcript.all().some((record) => record.type === 'delegation')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await h.runtime.conversation.send('/clear');
    await turn;

    await h.runtime.conversation.send('@claude something new');

    // The note said the agents would be briefed from scratch. They are: the
    // finishing task must not put back what the clear took away.
    expect(agent.prompts[1]).toContain('handsfree approves or refuses');
    // And nothing from before the line is carried across to it.
    expect(agent.prompts[1]).not.toContain('Since your last task:');
  });

  it('repeats a handoff the agent never got, rather than losing it', async () => {
    let edited = '';
    const claude = fakeAgent({
      script: () => [
        { do: 'tool', toolCallId: 't1', title: 'w', kind: 'edit', status: 'completed', locations: [edited] },
        { do: 'say', text: 'Added parse().' },
      ],
    });
    // gemini's first turn fails outright, the way a dying adapter does, so the
    // brief it carried is not known to have been read; the second one works.
    const gemini = fakeAgent({
      script: (_prompt, turn) =>
        turn === 0 ? [{ do: 'fail', message: 'adapter went away' }] : [{ do: 'say', text: 'ok' }],
    });
    const llm = scriptedModel([answer('a'), answer('b'), answer('c')]);
    const h = harness({ agents: { claude, gemini }, llm });
    open = h;
    edited = path.join(h.workspaceDir, 'a.ts');

    await h.runtime.conversation.send('@claude add parse()');
    await h.runtime.conversation.send('@gemini test it');
    await h.runtime.conversation.send('@gemini test it again');

    // The mark did not move past a brief nobody is known to have read, so what
    // claude changed is still told to gemini on the next attempt.
    expect(gemini.prompts.at(-1)).toContain('claude');
    expect(gemini.prompts.at(-1)).toContain('changed a.ts');
    // A session that may have lost the rules is given them again.
    expect(gemini.prompts.at(-1)).toContain('handsfree approves or refuses');
  });

  it('records the workspace path it gave the model', async () => {
    const agent = fakeAgent({ script: () => [] });
    const llm = scriptedModel([answer('ok')]);
    const h = harness({ agents: { claude: agent }, llm });
    open = h;

    await h.runtime.conversation.send('hello');

    const system = llm.seen[0]?.[0]?.content ?? '';
    expect(system).toContain(path.basename(h.workspaceDir));
  });
});

describe('Conversation across a restart', () => {
  it('reads the run back so the next agent is handed what happened before it', async () => {
    let edited = '';
    const claude = fakeAgent({
      // Resumable, and replays its past on load the way a real adapter does.
      loadSession: true,
      replay: ['Done. (replayed by the agent on session/load)'],
      script: (_prompt, turn) =>
        turn === 0
          ? [
              { do: 'tool', toolCallId: 't1', title: 'Write a.ts', kind: 'edit', locations: [edited] },
              { do: 'say', text: 'Done.\n\nREPORT\noutcome: done\nsummary: Added parse().\ndecided: - empty input returns null' },
            ]
          : [{ do: 'say', text: 'Tidied.' }],
    });
    const before = harness({ agents: { claude }, llm: scriptedModel([answer('a')]) });
    edited = path.join(before.workspaceDir, 'a.ts');
    await before.runtime.conversation.send('@claude add parse()');
    const { root } = before;
    const runId = before.runtime.workspace.id;
    // Closed, not disposed: the record has to survive for the next process.
    await before.runtime.close();

    const gemini = fakeAgent({ script: () => [{ do: 'say', text: 'ok' }] });
    const after = harness({
      agents: { claude, gemini },
      llm: scriptedModel([answer('b'), answer('c')]),
      resume: { root, runId },
    });
    open = after;
    await after.runtime.conversation.send('@gemini test parse()');
    await after.runtime.conversation.send('@claude tidy it');

    // gemini is told what claude did in the process before this one...
    expect(gemini.prompts[0]).toContain('Since your last task:');
    expect(gemini.prompts[0]).toContain('claude, task 1: changed a.ts');
    expect(gemini.prompts[0]).toContain('decided: empty input returns null');
    // ...and its own task is numbered after claude's, not over it.
    const delegations = after.runtime.transcript
      .all()
      .filter((record) => record.type === 'delegation')
      .map((record) => (record.type === 'delegation' ? [record.taskId, record.agentId] : []));
    expect(delegations).toEqual([
      [1, 'claude'],
      [2, 'gemini'],
      [3, 'claude'],
    ]);

    // claude came back on the session it had, which holds its own work: it
    // is told the rules again and what gemini did, not what it did itself.
    const resumed = claude.prompts[1] ?? '';
    expect(resumed).toContain('handsfree approves or refuses');
    expect(resumed).toContain('gemini, task 2');
    expect(resumed).not.toContain('claude, task 1');
    expect(resumed).not.toContain('Added parse().');

    // The session's return is on the record as what it is, not as a remark
    // in the conversation.
    const sessionRecords = after.runtime.transcript
      .all()
      .filter((record) => record.type === 'session' && record.agentId === 'claude');
    expect(sessionRecords.at(-1)).toMatchObject({ how: 'resumed' });
    expect(
      after.runtime.transcript.all().some((record) => record.type === 'note' && record.text.includes('resumed')),
    ).toBe(false);

    // What the agent replayed while loading was already on the record, and
    // is not on it twice.
    const replayed = after.runtime.transcript
      .all()
      .filter(
        (record) =>
          record.type === 'session_update' &&
          record.update.sessionUpdate === 'agent_message_chunk' &&
          record.update.content.type === 'text' &&
          record.update.content.text.includes('replayed by the agent'),
      );
    expect(replayed).toHaveLength(0);
  });

  it('waits out a replay that keeps arriving after the load was answered', async () => {
    const gemini = fakeAgent({
      loadSession: true,
      replay: ['late one', 'late two', 'late three'],
      replayLate: true,
      script: () => [{ do: 'say', text: 'ok\n\nREPORT\noutcome: done\nsummary: Fine.' }],
    });
    const before = harness({ agents: { gemini }, llm: scriptedModel([answer('a')]) });
    await before.runtime.conversation.send('@gemini one');
    const { root } = before;
    const runId = before.runtime.workspace.id;
    await before.runtime.close();

    const after = harness({ agents: { gemini }, llm: scriptedModel([answer('b')]), resume: { root, runId } });
    open = after;
    await after.runtime.conversation.send('@gemini two');

    const records = after.runtime.transcript.all();
    const late = records.filter(
      (record) =>
        record.type === 'session_update' &&
        record.update.sessionUpdate === 'agent_message_chunk' &&
        record.update.content.type === 'text' &&
        record.update.content.text.startsWith('late'),
    );
    expect(late).toHaveLength(0);
    // The turn itself is on the record, after the replay, whole.
    const task = records.filter((record) => record.type === 'delegation');
    expect(task.map((record) => (record.type === 'delegation' ? record.taskId : 0))).toEqual([1, 2]);
    expect(gemini.prompts).toHaveLength(2);
  });
});
