import { describe, expect, it } from 'vitest';
import { extractJsonObject, MessageStream } from './json.js';
import { parseStep } from './plan.js';

const agents = ['claude', 'gemini'];

describe('extractJsonObject', () => {
  it('finds an object wrapped in prose', () => {
    expect(extractJsonObject('Sure! {"a":1} hope that helps')).toBe('{"a":1}');
  });

  it('handles nested objects and braces inside strings', () => {
    expect(extractJsonObject('{"a":{"b":"}"},"c":2} trailing')).toBe('{"a":{"b":"}"},"c":2}');
  });

  it('returns nothing when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
  });
});

describe('MessageStream', () => {
  const drip = (text: string): string => {
    const stream = new MessageStream();
    let out = '';
    for (const ch of text) out += stream.push(ch);
    return out;
  };

  it('extracts the message as it streams, in any chunking', () => {
    const text = '{"action":"answer","message":"Hello there"}';
    expect(drip(text)).toBe('Hello there');
    expect(new MessageStream().push(text)).toBe('Hello there');
  });

  it('decodes escapes, even split across chunks', () => {
    expect(drip('{"message":"line\\none \\"two\\" \\u00e9!"}')).toBe('line\none "two" é!');
  });

  it('yields nothing for a delegation, which has no message', () => {
    expect(drip('{"action":"delegate","agent":"claude","task":"do it"}')).toBe('');
  });

  it('does not mistake a longer key for the message', () => {
    expect(drip('{"messages":"nope","message":"yes"}')).toBe('yes');
  });

  it('stops at the closing quote', () => {
    expect(drip('{"message":"hi"} {"message":"again"}')).toBe('hi');
  });

  it('survives whitespace around the colon', () => {
    expect(drip('{ "message" : "spaced" }')).toBe('spaced');
  });
});

describe('parseStep', () => {
  it('reads an answer', () => {
    const parsed = parseStep('{"action":"answer","message":"hi"}', agents);
    expect(parsed).toEqual({ ok: true, step: { action: 'answer', message: 'hi' } });
  });

  it('reads a delegation wrapped in a code fence', () => {
    const parsed = parseStep(
      '```json\n{"action":"delegate","agent":"claude","task":"do it"}\n```',
      agents,
    );
    expect(parsed.ok && parsed.step).toMatchObject({ action: 'delegate', agent: 'claude' });
  });

  it('refuses an agent that is not available', () => {
    const parsed = parseStep('{"action":"delegate","agent":"codex","task":"do it"}', agents);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('claude, gemini');
  });

  it('treats a delegation without a kind as a change', () => {
    const parsed = parseStep('{"action":"delegate","agent":"claude","task":"do it"}', agents);
    expect(parsed.ok && parsed.step).toMatchObject({ kind: 'change' });
  });

  it('reads a delegation that asks for an answer rather than a change', () => {
    const parsed = parseStep(
      '{"action":"delegate","agent":"claude","kind":"answer","task":"안녕?"}',
      agents,
    );
    expect(parsed.ok && parsed.step).toMatchObject({ kind: 'answer', task: '안녕?' });
  });

  it('refuses a kind that is neither', () => {
    expect(
      parseStep('{"action":"delegate","agent":"claude","kind":"ponder","task":"x"}', agents).ok,
    ).toBe(false);
  });

  it('refuses an empty task', () => {
    expect(parseStep('{"action":"delegate","agent":"claude","task":""}', agents).ok).toBe(false);
  });

  it('refuses an unknown action', () => {
    expect(parseStep('{"action":"sudo","message":"hi"}', agents).ok).toBe(false);
  });
});
