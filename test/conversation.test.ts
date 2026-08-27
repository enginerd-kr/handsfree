import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import type { ChatClient } from '../src/brain/client.js';

let open: Harness | undefined;

afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

const delegate = (task: string) =>
  JSON.stringify({ action: 'delegate', agent: 'claude', task });
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

  it('asks an agent a question without asking it to build anything', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'say', text: '안녕하세요!' }] });
    const llm = scriptedModel([
      JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: '안녕?' }),
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
      .filter((message) => message.content.startsWith('TASK RESULT'))
      .map((message) => message.content)
      .join('\n');
    expect(observations).toContain('refused');
    expect(observations).toContain('/etc/hosts');
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

    await h.runtime.conversation.send('make notes.txt');

    const reply = assistantText(h).at(-1) ?? '';
    expect(reply).toContain('adapter not installed');
    expect(reply).not.toContain('done');
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

  it('ends a cancelled turn silently, right where it stood', async () => {
    const agent = fakeAgent({ script: () => [{ do: 'stall', ms: 10_000 }] });
    let calls = 0;
    const llm: ChatClient = {
      async chat() {
        calls++;
        if (calls === 1) return delegate('Sleep forever');
        throw new Error('a cancelled turn must not ask the model anything');
      },
    };
    const h = harness({ agents: { claude: agent }, llm });
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
  });

  it('routes a leading @mention straight to its agent, planner unconsulted', async () => {
    const claude = fakeAgent({ script: () => [] });
    const gemini = fakeAgent({ script: () => [{ do: 'say', text: 'made it.' }] });
    // One reply only — the summary. A consulted planner would run the script dry.
    const llm = scriptedModel([answer('gemini made notes.txt.')]);
    const h = harness({ agents: { claude, gemini }, llm });
    open = h;

    await h.runtime.conversation.send('@gemini make notes.txt');

    expect(gemini.prompts[0]).toContain('make notes.txt');
    expect(gemini.prompts[0]).not.toContain('@gemini');
    expect(claude.prompts).toEqual([]);
    expect(llm.seen).toHaveLength(1);
    expect(assistantText(h)).toEqual(['gemini made notes.txt.']);

    const kinds = h.runtime.transcript.all().map((record) => record.type);
    expect(kinds).toContain('delegation');
    expect(kinds).toContain('stop');
  });

  it('leaves an @name nobody answers to for the planner to read', async () => {
    const claude = fakeAgent({ script: () => [] });
    const llm = scriptedModel([answer('nobody here goes by that name.')]);
    const h = harness({ agents: { claude }, llm });
    open = h;

    await h.runtime.conversation.send('@nobody do something');

    // The planner was consulted, and saw the line as it was typed.
    expect(llm.seen).toHaveLength(1);
    expect(llm.seen[0]?.some((message) => message.content === '@nobody do something')).toBe(true);
    expect(assistantText(h)).toEqual(['nobody here goes by that name.']);
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
