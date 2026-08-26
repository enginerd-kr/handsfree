import { describe, expect, it } from 'vitest';
import { initialTuiState, reducer, type TuiState } from './useOrchestrator.js';

const start = () => initialTuiState('/tmp/run-1');

/** Apply a sequence of events, the way the hook would. */
function apply(state: TuiState, ...events: Parameters<typeof reducer>[1][]): TuiState {
  return events.reduce(reducer, state);
}

describe('message queue', () => {
  it('holds messages typed during a turn instead of dropping them', () => {
    const state = apply(
      start(),
      { type: 'queue_message', text: 'first' },
      { type: 'start_queued' },
      { type: 'queue_message', text: 'second' },
      { type: 'queue_message', text: 'third' },
    );
    expect(state.phase).toBe('thinking');
    expect(state.queued).toEqual(['second', 'third']);
    expect(state.items.map((i) => i.text)).toEqual(['first']);
  });

  it('runs queued messages in the order they were typed', () => {
    let state = apply(
      start(),
      { type: 'queue_message', text: 'first' },
      { type: 'queue_message', text: 'second' },
    );
    state = apply(state, { type: 'start_queued' }, { type: 'turn_done' });
    expect(state.queued).toEqual(['second']);
    state = apply(state, { type: 'start_queued' });
    expect(state.queued).toEqual([]);
    expect(state.items.map((i) => i.text)).toEqual(['first', 'second']);
  });

  it('is a no-op when there is nothing queued', () => {
    const state = start();
    expect(reducer(state, { type: 'start_queued' })).toBe(state);
  });

  it('drops the queue on /clear', () => {
    const state = apply(
      start(),
      { type: 'queue_message', text: 'first' },
      { type: 'queue_message', text: 'second' },
      { type: 'clear' },
    );
    expect(state.queued).toEqual([]);
    expect(state.phase).toBe('idle');
    expect(state.generation).toBe(1);
  });
});

describe('live task output', () => {
  const started = () =>
    apply(start(), { type: 'task_started', id: 1, agent: 'claude', task: 'do it' });

  it('keeps only the tail of a noisy stream', () => {
    let state = started();
    for (let i = 0; i < 50; i++) {
      state = reducer(state, { type: 'task_output_chunk', chunk: `line ${i}\n` });
    }
    expect(state.activeTask?.outputTail).toHaveLength(8);
    expect(state.activeTask?.outputTail.at(-1)).toBe('line 49');
  });

  it('accepts a coalesced multi-line chunk and drops blank lines', () => {
    const state = reducer(started(), { type: 'task_output_chunk', chunk: 'a\n\nb\n' });
    expect(state.activeTask?.outputTail).toEqual(['a', 'b']);
  });

  it('ignores output arriving with no active task', () => {
    const state = start();
    expect(reducer(state, { type: 'task_output_chunk', chunk: 'noise' })).toBe(state);
  });

  it('clears the active task and records the outcome when it finishes', () => {
    const state = apply(started(), {
      type: 'task_finished',
      id: 1,
      agent: 'claude',
      status: 'success',
    });
    expect(state.activeTask).toBeUndefined();
    expect(state.tasks[0].status).toBe('success');
    expect(state.items.at(-1)).toMatchObject({
      kind: 'task',
      agent: 'claude',
      id: 1,
      status: 'success',
      text: 'do it',
    });
  });
});
