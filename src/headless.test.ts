import { describe, expect, it } from 'vitest';
import { formatEvent, type HeadlessEvent } from './headless.js';

const events: HeadlessEvent[] = [
  { type: 'workspace', runDir: '/tmp/run-1' },
  { type: 'assistant', text: 'line one\nline two' },
  { type: 'task_started', id: 1, agent: 'claude', task: 'Create notes.txt' },
  { type: 'task_finished', id: 1, agent: 'claude', status: 'success', summary: 'Created notes.txt' },
  { type: 'error', message: 'boom' },
  { type: 'turn_done' },
];

describe('headless text protocol', () => {
  it('renders one readable line per event', () => {
    expect(events.map((e) => formatEvent(e, 'text'))).toEqual([
      '[workspace] /tmp/run-1',
      '[assistant] line one\\nline two',
      '[task claude #1] started Create notes.txt',
      '[task claude #1] finished: success',
      '[error] boom',
      '[done]',
    ]);
  });

  it('never emits a raw newline, so one event stays one line', () => {
    for (const event of events) {
      expect(formatEvent(event, 'text')).not.toContain('\n');
    }
  });

  it('abbreviates a very long task description', () => {
    const line = formatEvent(
      { type: 'task_started', id: 1, agent: 'codex', task: 'x'.repeat(500) },
      'text',
    );
    expect(line.length).toBeLessThan(250);
  });
});

describe('headless json protocol', () => {
  it('emits one parseable object per event', () => {
    const parsed = events.map((e) => JSON.parse(formatEvent(e, 'json')) as HeadlessEvent);
    expect(parsed).toEqual(events);
  });

  it('never emits a raw newline, so JSONL stays line-delimited', () => {
    for (const event of events) {
      expect(formatEvent(event, 'json')).not.toContain('\n');
    }
  });

  it('keeps the full task and summary, unlike the text form', () => {
    const task = 'y'.repeat(500);
    const event = JSON.parse(
      formatEvent({ type: 'task_started', id: 2, agent: 'gemini', task }, 'json'),
    ) as Extract<HeadlessEvent, { type: 'task_started' }>;
    expect(event.task).toBe(task);
  });
});
