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
    const review = { objective: 'Review the code', constraints: [], completed: [], remaining: ['Run review'], next: -1, blocker: 'Worker budget exhausted.' };
    const box = new Toolbox([]);
    const parsed = box.parse(JSON.stringify({ review, action: 'answer', message: 'The review could not run because its budget is exhausted.' }));
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
