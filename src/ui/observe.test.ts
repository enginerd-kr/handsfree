import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transcript } from '../workspace/transcript.js';
import { observeView, type ViewUpdate } from './observe.js';
import { buildView, createView } from './view-model.js';

afterEach(() => vi.useRealTimers());

describe('incremental transcript display', () => {
  it('batches chunks, preserves whitespace, and flushes a completed reply immediately', () => {
    vi.useFakeTimers();
    const transcript = new Transcript();
    const updates: ViewUpdate[] = [];
    const stop = observeView(transcript, '/ws', {}, (view) => updates.push(view));
    transcript.append({ type: 'assistant_delta', stream: 1, text: 'Hello ' });
    transcript.append({ type: 'assistant_delta', stream: 1, text: 'world' });
    expect(updates).toHaveLength(1);
    vi.advanceTimersByTime(24);
    expect(updates.at(-1)!.items[0]!.text).toBe('Hello world');
    expect(updates.at(-1)!.spend).toBeUndefined();
    transcript.append({ type: 'assistant_delta', stream: 1, text: '!' });
    transcript.append({ type: 'assistant', stream: 1, text: 'Hello world!' });
    expect(updates.at(-1)!.items[0]!.text).toBe('Hello world!');
    const count = updates.length;
    vi.advanceTimersByTime(100);
    expect(updates).toHaveLength(count);
    stop();
    transcript.append({ type: 'note', level: 'info', text: 'unmounted' });
    expect(updates).toHaveLength(count);
  });

  it('keeps settled row identities and does not mutate earlier snapshots', () => {
    const transcript = new Transcript();
    const view = createView('/ws');
    const push = (body: Parameters<Transcript['append']>[0]) => view.push(transcript.append(body));
    push({ type: 'user', text: 'One' });
    push({ type: 'assistant', text: 'Done.' });
    const before = view.snapshot();
    push({ type: 'user', text: 'Two' });
    push({ type: 'assistant_delta', stream: 1, text: 'Next ' });
    const middle = view.snapshot();
    push({ type: 'assistant_delta', stream: 1, text: 'reply' });
    expect(view.snapshot()[0]).toBe(before[0]);
    expect(view.snapshot()[1]).toBe(before[1]);
    expect(middle.at(-1)!.text).toBe('Next');
    expect(view.snapshot()).toEqual(buildView(transcript.all(), '/ws'));
  });

  it('keeps interleaved replies and folding attached to their own task', () => {
    const transcript = new Transcript();
    const view = createView('/ws');
    const push = (body: Parameters<Transcript['append']>[0]) => view.push(transcript.append(body));
    const say = (agentId: string, text: string) => push({ type: 'session_update', agentId, sessionId: agentId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    for (const [taskId, agentId] of [[1, 'a'], [2, 'b']] as const) push({ type: 'delegation', taskId, agentId, sessionId: agentId, task: `Ask ${agentId}`, kind: 'answer' });
    say('a', 'Alpha '); say('b', 'Beta '); say('a', 'one');
    push({ type: 'stop', taskId: 1, agentId: 'a', sessionId: 'a', stopReason: 'end_turn' });
    const interim = view.snapshot();
    expect(interim.find((row) => row.text === 'Alpha one')).toMatchObject({ agentId: 'a' });
    expect(interim.find((row) => row.text === 'Alpha one')!.live).toBeUndefined();
    expect(interim.find((row) => row.text === 'Beta')).toMatchObject({ agentId: 'b', live: true });
    say('b', 'two');
    push({ type: 'stop', taskId: 2, agentId: 'b', sessionId: 'b', stopReason: 'end_turn' });
    expect(view.snapshot().filter((row) => row.prose).map((row) => [row.agentId, row.text])).toEqual([['a', 'Alpha one'], ['b', 'Beta two']]);
    expect(view.snapshot().some((row) => row.live)).toBe(false);
  });

  it('clears pending text and preserves active task ownership after a clear', () => {
    vi.useFakeTimers();
    const transcript = new Transcript();
    const updates: ViewUpdate[] = [];
    const clear = vi.fn();
    const stop = observeView(transcript, '/ws', {}, (view) => updates.push(view), clear);
    transcript.append({ type: 'assistant_delta', stream: 1, text: 'Old' });
    transcript.append({ type: 'clear' });
    expect(clear).toHaveBeenCalledOnce();
    expect(updates.at(-1)!.items).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(updates.at(-1)!.items).toEqual([]);
    stop();
  });
});
