import { describe, expect, it } from 'vitest';
import { NOTHING_SENT, recall, remember, settle, type History } from './history.js';

/** A memory of a run that sent these lines, oldest first, and is not walking it. */
const sent = (...lines: string[]): History =>
  lines.reduce((history, line) => remember(history, line), NOTHING_SENT);

describe('remember', () => {
  it('keeps what was sent, oldest first', () => {
    expect(sent('one', 'two').entries).toEqual(['one', 'two']);
  });

  it('counts a line sent twice in a row once', () => {
    expect(sent('one', 'one', 'two', 'one').entries).toEqual(['one', 'two', 'one']);
  });

  it('ends the walk the sent line came from', () => {
    const walking = recall(sent('one', 'two'), '', 'back')!.history;
    expect(walking.at).toBe(1);
    expect(remember(walking, 'two')).toEqual({ entries: ['one', 'two'], at: 0, pending: '' });
  });
});

describe('recall', () => {
  it('walks back to the newest line first, and on to the oldest', () => {
    let history = sent('one', 'two', 'three');
    const back = (typed: string) => {
      const step = recall(history, typed, 'back')!;
      history = step.history;
      return step.value;
    };
    expect(back('half')).toBe('three');
    expect(back('three')).toBe('two');
    expect(back('two')).toBe('one');
  });

  it('stops at the oldest line rather than wrapping', () => {
    let history = sent('one');
    history = recall(history, '', 'back')!.history;
    expect(recall(history, 'one', 'back')).toBeUndefined();
  });

  it('has nowhere to go back to when nothing has been sent', () => {
    expect(recall(NOTHING_SENT, 'half', 'back')).toBeUndefined();
  });

  it('leaves the draft alone when the prompt is already holding it', () => {
    expect(recall(sent('one'), 'half', 'forward')).toBeUndefined();
  });

  it('hands back what was half-written at the end of the way forward', () => {
    let history = sent('one', 'two');
    history = recall(history, 'half', 'back')!.history;
    history = recall(history, 'two', 'back')!.history;
    const forward = recall(history, 'one', 'forward')!;
    expect(forward.value).toBe('two');
    expect(recall(forward.history, 'two', 'forward')!.value).toBe('half');
  });
});

describe('settle', () => {
  it('forgets the walk, so the next step back starts from the newest line', () => {
    let history = sent('one', 'two');
    history = recall(history, 'half', 'back')!.history;
    history = settle(history);
    expect(recall(history, 'two, edited', 'back')!.value).toBe('two');
    expect(recall(history, 'two, edited', 'forward')).toBeUndefined();
  });
});
