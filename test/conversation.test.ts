import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import type { ChatClient } from '../src/brain/client.js';
import { describeRecord } from '../src/ui/view-model.js';

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
    expect(llm.seen[0]?.some((message) => message.content === '@nobody do something')).toBe(true);
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

  it('keeps the run in the system prompt and folds the turn that established it', async () => {
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

    const second = llm.seen.at(-1) ?? [];
    // The task is in the system prompt, as a line rebuilt from the record...
    expect(second[0]?.content).toContain('Task 1 (claude): done');
    expect(second[0]?.content).toContain('Files changed this run: a.ts');
    // ...and the turn that produced it is two messages, not five.
    expect(second.slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.some((message) => message.content.startsWith('TASK RESULT'))).toBe(false);
    expect(JSON.stringify(second)).not.toContain('A long account');
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

    const system = llm.seen.at(-1)?.[0]?.content ?? '';
    // The role says what each is for...
    expect(system).toContain('"claude": strong at multi-file edits');
    expect(system).toContain('"gemini": fast on single files');
    // ...and the record says which one would not have to read the file again.
    expect(system).toContain('1 task this run; already has a.ts open');
    // An agent that has done nothing is described, not annotated.
    expect(system).not.toContain('"gemini": fast on single files\n  (');
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
    expect(after[1]?.content).toBe('hello again');
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
