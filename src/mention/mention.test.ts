import { describe, expect, it } from 'vitest';
import {
  completeMention,
  completeModel,
  mentionSpans,
  mentionTokenAt,
  modelTokenAt,
  parseMention,
  suggestAgents,
  suggestModels,
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
    // No trailing space: the next keystroke may be the colon that picks a model.
    expect(completeMention({ value: '@ge tail', cursor: 3 }, 'gemini')).toEqual({
      value: '@gemini tail',
      cursor: 7,
    });
  });

  it('does nothing when the cursor is not in a mention', () => {
    expect(completeMention({ value: 'plain', cursor: 5 }, 'gemini')).toEqual({
      value: 'plain',
      cursor: 5,
    });
  });
});

describe('modelTokenAt', () => {
  it('opens on a colon after a known agent, query so far included', () => {
    expect(modelTokenAt('@gemini:', 8, AGENTS)).toEqual({ start: 0, agent: 'gemini', query: '' });
    expect(modelTokenAt('@gemini:fla', 11, AGENTS)).toEqual({
      start: 0,
      agent: 'gemini',
      query: 'fla',
    });
  });

  it('stays shut after a name that is no agent, and mid-word', () => {
    expect(modelTokenAt('@nobody:fla', 11, AGENTS)).toBeUndefined();
    expect(modelTokenAt('me@gemini:fla', 13, AGENTS)).toBeUndefined();
  });

  it('is not open while the cursor is still in the name', () => {
    expect(modelTokenAt('@gemini:fla', 5, AGENTS)).toBeUndefined();
  });
});

describe('modelTokenAt', () => {
  it('spells a bracketed id, which is how a variant is named', () => {
    // claude-agent-acp's long-context Opus. The brackets are part of the id.
    expect(modelTokenAt('@claude:opus[1m', 15, AGENTS)).toEqual({
      start: 0,
      agent: 'claude',
      query: 'opus[1m',
    });
    expect(modelTokenAt('@claude:opus[1m]', 16, AGENTS)).toEqual({
      start: 0,
      agent: 'claude',
      query: 'opus[1m]',
    });
  });

  it('closes once the address is left behind', () => {
    expect(modelTokenAt('@claude:opus[1m] hi', 19, AGENTS)).toBeUndefined();
  });
});

describe('suggestModels', () => {
  const CHOICES = [
    { value: 'gemini-3.5-flash' },
    { value: 'gemini-3.1-flash-lite' },
    { value: 'gemini-2.5-pro' },
  ];
  const ids = (query: string) => suggestModels(query, CHOICES).map((c) => c.value);

  it('offers the whole roster for a bare colon, in the order it was advertised', () => {
    expect(ids('')).toEqual(CHOICES.map((c) => c.value));
    expect(ids('gemini-2')).toEqual(['gemini-2.5-pro']);
  });

  it('ranks by how the name was typed and keeps the agent order within a rank', () => {
    // Both flashes are substring hits and stay in the order given; nothing is
    // promoted over another by length or letter.
    expect(ids('flash')).toEqual(['gemini-3.5-flash', 'gemini-3.1-flash-lite']);
    expect(ids('gemini-3.1')).toEqual(['gemini-3.1-flash-lite']);
  });
});

describe('parseMention with a bracketed model', () => {
  it('routes a line whose model id carries brackets', () => {
    expect(parseMention('@claude:opus[1m] 하이?', AGENTS)).toEqual({
      agent: 'claude',
      model: 'opus[1m]',
      task: '하이?',
    });
  });

  it('still refuses a model id with characters no adapter spells', () => {
    expect(parseMention('@claude:opus/1m do it', AGENTS)).toBeUndefined();
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

  it('takes a :model suffix into the span, dots and all', () => {
    expect(mentionSpans('@gemini:gemini-3.5-flash go', AGENTS)).toEqual([
      { start: 0, end: 24, agent: 'gemini', model: 'gemini-3.5-flash' },
    ]);
  });

  it('leaves a bare colon outside: "@gemini:" is a mention and then punctuation', () => {
    expect(mentionSpans('@gemini: do it', AGENTS)).toEqual([
      { start: 0, end: 7, agent: 'gemini' },
    ]);
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

  it('reads a :model suffix as the model the task should run on', () => {
    expect(parseMention('@claude:opus fix the tests', AGENTS)).toEqual({
      agent: 'claude',
      model: 'opus',
      task: 'fix the tests',
    });
    expect(parseMention('@gemini:gemini-3.5-flash 번역해줘', AGENTS)).toEqual({
      agent: 'gemini',
      model: 'gemini-3.5-flash',
      task: '번역해줘',
    });
  });

  it('treats a colon with no model, or one spelled wrong, as ordinary text', () => {
    expect(parseMention('@claude: fix it', AGENTS)).toBeUndefined();
    expect(parseMention('@claude:op!us fix it', AGENTS)).toBeUndefined();
    expect(parseMention('@nobody:opus fix it', AGENTS)).toBeUndefined();
  });
});
