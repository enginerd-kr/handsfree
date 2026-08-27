import { describe, expect, it } from 'vitest';
import {
  completeMention,
  mentionSpans,
  mentionTokenAt,
  parseMention,
  suggestAgents,
} from './mention.js';

const AGENTS = ['claude', 'gemini', 'codex'] as const;

describe('mentionTokenAt', () => {
  it('opens on a bare @ at the start of a word', () => {
    expect(mentionTokenAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionTokenAt('ask @ge', 7)).toEqual({ start: 4, query: 'ge' });
  });

  it('stays shut mid-word: an email address is not a mention', () => {
    expect(mentionTokenAt('me@ge', 5)).toBeUndefined();
  });

  it('measures in code points, so an emoji before it does not shift the token', () => {
    // '🙂' is one code point but two UTF-16 units.
    expect(mentionTokenAt('🙂 @ge', 5)).toEqual({ start: 2, query: 'ge' });
  });

  it('reads only up to the cursor', () => {
    expect(mentionTokenAt('@gemini', 3)).toEqual({ start: 0, query: 'ge' });
  });

  it('is not open once the name has been left behind', () => {
    expect(mentionTokenAt('@gemini do it', 9)).toBeUndefined();
  });
});

describe('suggestAgents', () => {
  it('offers everyone for a bare @', () => {
    expect(suggestAgents('@', 1, AGENTS)).toEqual(['codex', 'claude', 'gemini']);
  });

  it('filters by prefix before substring', () => {
    expect(suggestAgents('@ge', 3, AGENTS)).toEqual(['gemini']);
    expect(suggestAgents('@de', 3, AGENTS)).toEqual(['codex', 'claude']);
  });

  it('offers nothing where no mention is open', () => {
    expect(suggestAgents('hello', 5, AGENTS)).toEqual([]);
    expect(suggestAgents('me@ge', 5, AGENTS)).toEqual([]);
  });
});

describe('completeMention', () => {
  it('replaces the half-written token, @ included, and leaves the tail alone', () => {
    expect(completeMention({ value: '@ge tail', cursor: 3 }, 'gemini')).toEqual({
      value: '@gemini  tail',
      cursor: 8,
    });
  });

  it('does nothing when the cursor is not in a mention', () => {
    expect(completeMention({ value: 'plain', cursor: 5 }, 'gemini')).toEqual({
      value: 'plain',
      cursor: 5,
    });
  });
});

describe('mentionSpans', () => {
  it('finds every configured agent, and only those', () => {
    expect(mentionSpans('@gemini then @codex then @nobody', AGENTS)).toEqual([
      { start: 0, end: 7, agent: 'gemini' },
      { start: 13, end: 19, agent: 'codex' },
    ]);
  });

  it('leaves a name that only starts like an agent uncoloured', () => {
    expect(mentionSpans('@geminix', AGENTS)).toEqual([]);
  });

  it('leaves an email address alone', () => {
    expect(mentionSpans('me@gemini', AGENTS)).toEqual([]);
  });

  it('answers in code points: a wide char before the mention still measures true', () => {
    expect(mentionSpans('🙂 @gemini', AGENTS)).toEqual([{ start: 2, end: 9, agent: 'gemini' }]);
  });

  it('keeps the config spelling whatever case was typed', () => {
    expect(mentionSpans('@Gemini', AGENTS)).toEqual([{ start: 0, end: 7, agent: 'gemini' }]);
  });
});

describe('parseMention', () => {
  it('splits a leading mention into recipient and task', () => {
    expect(parseMention('@gemini fix the tests', AGENTS)).toEqual({
      agent: 'gemini',
      task: 'fix the tests',
    });
  });

  it('canonicalises the case the config uses', () => {
    expect(parseMention('@GEMINI 안녕?', AGENTS)).toEqual({ agent: 'gemini', task: '안녕?' });
  });

  it('is conservative: unknown names and bare mentions are ordinary text', () => {
    expect(parseMention('@nobody do it', AGENTS)).toBeUndefined();
    expect(parseMention('@gemini', AGENTS)).toBeUndefined();
    expect(parseMention('@gemini   ', AGENTS)).toBeUndefined();
  });

  it('only routes from the front of the line', () => {
    expect(parseMention('ask @gemini something', AGENTS)).toBeUndefined();
  });
});
