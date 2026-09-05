import { describe, expect, it } from 'vitest';
import { extractJsonObject, MessageStream } from './json.js';

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

  it('yields nothing for a tool call, which has no message', () => {
    expect(drip('{"action":"call","tool":"agent","input":{"agent":"claude","prompt":"do it"}}')).toBe('');
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
