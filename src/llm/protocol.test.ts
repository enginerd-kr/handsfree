import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseAction } from './protocol.js';

describe('protocol', () => {
  it('parses a respond action', () => {
    const res = parseAction('{"action":"respond","message":"hi"}');
    expect(res).toEqual({ ok: true, action: { action: 'respond', message: 'hi' } });
  });

  it('parses a delegate action', () => {
    const res = parseAction('{"action":"delegate","agent":"claude","task":"make a file"}');
    expect(res.ok).toBe(true);
  });

  it('extracts JSON wrapped in prose and code fences', () => {
    const text = 'Sure! Here you go:\n```json\n{"action":"respond","message":"a {nested} \\"str\\""}\n```';
    expect(extractJsonObject(text)).toBe('{"action":"respond","message":"a {nested} \\"str\\""}');
    expect(parseAction(text).ok).toBe(true);
  });

  it('rejects unknown agents', () => {
    const res = parseAction('{"action":"delegate","agent":"gpt5","task":"x"}');
    expect(res.ok).toBe(false);
  });

  it('reports missing JSON', () => {
    expect(parseAction('no json here').ok).toBe(false);
  });
});
