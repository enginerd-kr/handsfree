import { describe, expect, it } from 'vitest';
import type { Delegator, Delegation } from '../../execution/delegate.js';
import type { TaskOutcome } from '../../results/outcome.js';
import { Transcript } from '../../../workspace/transcript.js';
import { AgentTool } from './agent.js';
import { Toolbox } from './tool.js';

const outcomeOf = (delegation: Delegation): TaskOutcome => ({
  taskId: 1,
  agentId: delegation.agentId,
  task: delegation.prompt,
  status: 'done',
  message: 'Made it so.\n\nREPORT\noutcome: done\nsummary: Made it so.',
  report: { outcome: 'done', summary: 'Made it so.', changed: [], decided: [], open: [], verify: '', structured: true },
  files: [],
  changed: [],
  denials: [],
  durationMs: 10,
  briefChars: 40,
});

function tool(roster = ['claude', 'gemini']) {
  const delegated: Delegation[] = [];
  const delegator = {
    async delegate(delegation: Delegation) {
      delegated.push(delegation);
      return outcomeOf(delegation);
    },
  } as unknown as Delegator;
  const transcript = new Transcript();
  const agent = new AgentTool({
    roster: () => roster.map((id) => ({ id, description: `${id} does things` })),
    delegator,
    transcript,
    workspace: { dir: '/ws' } as never,
  });
  return { agent, delegated, transcript, box: new Toolbox([agent]) };
}

const ctx = { signal: new AbortController().signal };

describe('AgentTool', () => {
  it('validates grouped recipients and delegates duplicates only once', async () => {
    const { box, delegated } = tool();
    for (const agent of [[], ['claude', 'missing']]) {
      expect(box.parse(JSON.stringify({ action: 'call', tool: 'agent', input: { agent, prompt: 'Hi' } })).ok).toBe(false);
    }
    const parsed = box.parse(JSON.stringify({ action: 'call', tool: 'agent', input: { agent: ['claude', 'gemini', 'claude'], kind: 'answer', prompt: 'Hi' } }));
    if (!parsed.ok || parsed.step.action !== 'call') throw new Error('not a call');
    const result = await parsed.step.call.run(ctx);
    expect(delegated.map((d) => d.agentId)).toEqual(['claude', 'gemini']);
    expect(result.outcomes).toHaveLength(2);
    expect(result.callsUsed).toBe(2);
  });

  it('stops a group when cancelled and names recipients not contacted', async () => {
    const { agent, delegated } = tool();
    const controller = new AbortController();
    controller.abort();
    const result = await agent.run({ agent: ['claude', 'gemini'], kind: 'answer', prompt: 'Hi' }, { signal: controller.signal });
    expect(delegated).toHaveLength(0);
    expect(result.callsUsed).toBe(0);
    expect(result.halt).toBe(true);
    expect(result.note).toContain('Not contacted (cancelled): claude, gemini');
  });

  it('describes the roster and how to call it', () => {
    const { agent } = tool();
    const text = agent.describe();
    expect(text).toContain('"claude": claude does things');
    expect(text).toContain('"gemini": gemini does things');
    expect(text).toContain('/ws');
    expect(text).toContain('{"action":"call","tool":"agent"');
  });

  it('refuses an agent that is not on the roster, naming the ones that are', () => {
    const parsed = tool().box.parse('{"action":"call","tool":"agent","input":{"agent":"codex","prompt":"do it"}}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/claude|gemini/);
  });

  it('treats a call without a kind as a change, and refuses a kind that is neither', () => {
    const { box } = tool();
    const parsed = box.parse('{"action":"call","tool":"agent","input":{"agent":"claude","prompt":"do it"}}');
    if (!parsed.ok || parsed.step.action !== 'call') throw new Error('not a call');
    expect(JSON.parse(parsed.step.call.json).input).toMatchObject({ kind: 'change' });
    expect(
      box.parse('{"action":"call","tool":"agent","input":{"agent":"claude","kind":"ponder","prompt":"x"}}').ok,
    ).toBe(false);
  });

  it('refuses an empty prompt', () => {
    expect(tool().box.parse('{"action":"call","tool":"agent","input":{"agent":"claude","prompt":""}}').ok).toBe(false);
  });

  it('accepts only positive integer task ids as context references', () => {
    const { box } = tool();
    const parse = (context_from: unknown) => box.parse(JSON.stringify({
      action: 'call', tool: 'agent', input: { agent: 'claude', prompt: 'Review the earlier reply', context_from },
    }));
    for (const refs of [[0], [-1], [1.5], ['1'], 1]) expect(parse(refs).ok).toBe(false);
    for (const refs of [[], [1], [1, 2]]) expect(parse(refs).ok).toBe(true);
    expect(JSON.stringify(box.jsonSchema().schema)).toContain('context_from');
  });

  it('treats default-model aliases as no override', async () => {
    const { agent, delegated } = tool();
    for (const model of ['default', 'none', 'null']) await agent.run({ agent: 'claude', kind: 'answer', prompt: 'Hi', model }, ctx);
    expect(delegated.map((d) => d.model)).toEqual([undefined, undefined, undefined]);
  });

  it('hands the call to the delegator as written, and relays the outcome', async () => {
    const { box, delegated, transcript } = tool();
    const parsed = box.parse(
      '{"action":"call","tool":"agent","input":{"agent":"claude","kind":"answer","description":"greet claude","prompt":"안녕?","model":"haiku"}}',
    );
    if (!parsed.ok || parsed.step.action !== 'call') throw new Error('not a call');
    const result = await parsed.step.call.run(ctx);

    expect(delegated).toEqual([
      { agentId: 'claude', kind: 'answer', prompt: '안녕?', title: 'greet claude', model: 'haiku' },
    ]);
    expect(result.outcome?.status).toBe('done');
    expect(result.halt).toBeFalsy();
    expect(result.text).toContain('Task 1 (claude): done');
    expect(result.text).toContain('summary: Made it so.');
    expect(result.text).toContain(outcomeOf(delegated[0]!).message);
    const usage = transcript.all().find((record) => record.type === 'usage');
    expect(usage).toMatchObject({ purpose: 'task', taskId: 1, promptChars: 40, relayedChars: result.text.length });
  });
});
