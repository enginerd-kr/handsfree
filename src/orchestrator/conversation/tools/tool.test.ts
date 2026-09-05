import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Toolbox, type Tool, type ToolContext } from './tool.js';

/** A tool of no consequence: it repeats what it was given, and remembers the call. */
function echoTool(): Tool<{ text: string; loud?: boolean | undefined }> & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name: 'echo',
    calls,
    describe: () => 'echo — says the input back.\nInput: {"text":"<what to say>"}',
    input: z.object({ text: z.string().min(1), loud: z.boolean().optional() }),
    async run(input) {
      calls.push(input);
      return { text: input.loud ? input.text.toUpperCase() : input.text };
    },
  };
}

const ctx: ToolContext = { signal: new AbortController().signal };

describe('Toolbox', () => {
  it('reads an answer', () => {
    const parsed = new Toolbox([echoTool()]).parse('{"action":"answer","message":"hi"}');
    expect(parsed).toEqual({ ok: true, step: { action: 'answer', message: 'hi' } });
  });

  it('requires a nonempty final report', () => {
    const box = new Toolbox([]);
    expect(box.parse('{"action":"answer","message":"   "}').ok).toBe(false);
  });

  it('permits a blocker report while retaining explicit unfinished work', () => {
    const review = { objective: 'Review the code', constraints: [], completed: [], remaining: ['Run review'], next: -1, blocker: 'Worker unavailable.' };
    const box = new Toolbox([]);
    const parsed = box.parse(JSON.stringify({ review, action: 'answer', message: 'The review could not run because the worker is unavailable.' }));
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(box.jsonSchema().schema)).toContain('"review"');
  });

  it('reads a call wrapped in a code fence and hands it to the tool, input checked', async () => {
    const echo = echoTool();
    const parsed = new Toolbox([echo]).parse(
      '```json\n{"action":"call","tool":"echo","input":{"text":"do it","loud":true}}\n```',
    );
    expect(parsed.ok && parsed.step.action === 'call' && parsed.step.call.name).toBe('echo');
    if (!parsed.ok || parsed.step.action !== 'call') throw new Error('not a call');
    const result = await parsed.step.call.run(ctx);
    expect(result.text).toBe('DO IT');
    expect(echo.calls).toEqual([{ text: 'do it', loud: true }]);
  });

  it.each([
    { remaining: [], next: -1, selected: 'Check the diff again' },
    { remaining: [], next: 0, selected: 'Check the diff again' },
    { remaining: ['Retry inspection'], next: 1, selected: 'Retry inspection' },
    { remaining: ['Retry inspection', 'Summarize'], next: -1, selected: 'Retry inspection' },
    { remaining: ['Summarize', 'Retry inspection'], next: 1, selected: 'Retry inspection' },
  ])('recovers worker bookkeeping for $remaining with next=$next', async ({ remaining, next, selected }) => {
    const calls: unknown[] = [];
    const worker: Tool<{ prompt: string }> = {
      name: 'agent', describe: () => '', input: z.object({ prompt: z.string().min(1) }),
      async run(input) { calls.push(input); return { text: 'done' }; },
    };
    const parsed = new Toolbox([worker]).parse(JSON.stringify({
      review: { objective: 'Inspect changes', constraints: ['Do not edit'], completed: [], remaining, next, blocker: '' },
      action: 'call', tool: 'agent', input: { prompt: 'Check the diff again' },
    }));
    if (!parsed.ok || parsed.step.action !== 'call') throw new Error('not a call');
    expect(parsed.step.review?.remaining[parsed.step.review.next]).toBe(selected);
    expect(parsed.step.review?.constraints).toEqual(['Do not edit']);
    await parsed.step.call.run(ctx);
    expect(calls).toEqual([{ prompt: 'Check the diff again' }]);
  });

  it('requires a repair when an invalid index leaves several worker items to choose from', () => {
    const worker = { ...echoTool(), name: 'agent' };
    const parsed = new Toolbox([worker]).parse(JSON.stringify({
      review: { objective: 'Inspect changes', constraints: [], completed: [], remaining: ['Inspect', 'Test'], next: 2, blocker: '' },
      action: 'call', tool: 'agent', input: { text: 'do it' },
    }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('zero-based index');
    expect(worker.calls).toEqual([]);
  });

  it('does not recover bookkeeping at the expense of worker input validation', () => {
    const worker = { ...echoTool(), name: 'agent' };
    const parsed = new Toolbox([worker]).parse(JSON.stringify({
      review: { objective: 'Inspect changes', constraints: [], completed: [], remaining: [], next: -1, blocker: '' },
      action: 'call', tool: 'agent', input: { text: '' },
    }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('Input for "agent"');
    expect(worker.calls).toEqual([]);
  });

  it('keeps the call as JSON in the shape the planner should have written', () => {
    const parsed = new Toolbox([echoTool()]).parse('{"action":"call","tool":"echo","input":{"text":"x"}}');
    if (!parsed.ok || parsed.step.action !== 'call') throw new Error('not a call');
    expect(JSON.parse(parsed.step.call.json)).toEqual({ action: 'call', tool: 'echo', input: { text: 'x' } });
  });

  it('refuses a tool it does not have, naming the ones it does', () => {
    const parsed = new Toolbox([echoTool()]).parse('{"action":"call","tool":"shout","input":{}}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('Tools: echo');
  });

  it('refuses an input the tool refuses, naming the field', () => {
    const parsed = new Toolbox([echoTool()]).parse('{"action":"call","tool":"echo","input":{"text":""}}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('"text"');
  });

  it('refuses an unknown action', () => {
    expect(new Toolbox([echoTool()]).parse('{"action":"sudo","message":"hi"}').ok).toBe(false);
  });

  it('refuses two tools of one name', () => {
    expect(() => new Toolbox([echoTool(), echoTool()])).toThrow('echo');
  });

  it('describes every tool for the system prompt, and shapes the schema on their inputs', () => {
    const box = new Toolbox([echoTool()]);
    expect(box.describe()).toContain('echo — says the input back.');
    const schema = JSON.stringify(box.jsonSchema().schema);
    expect(schema).toContain('"echo"');
    expect(schema).toContain('"loud"');
    expect(schema).toContain('"answer"');
  });
});
