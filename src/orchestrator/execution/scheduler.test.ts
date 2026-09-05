import { describe, expect, it } from 'vitest';
import { TaskScheduler, workspaceScheduler } from './scheduler.js';

describe('workspace scheduling', () => {
  it('shares exclusion across runtimes and releases cancelled waiters without starving changes', async () => {
    const first = workspaceScheduler('/test-shared-checkout');
    const second = workspaceScheduler('/test-shared-checkout');
    const signal = new AbortController().signal;
    const read = await first.scheduler.acquire('a', false, signal);
    const events: string[] = [];
    const change = second.scheduler.acquire('b', true, signal).then((release) => { events.push('write'); return release; });
    const cancelled = new AbortController();
    const waiting = first.scheduler.acquire('c', false, cancelled.signal);
    const rejection = expect(waiting).rejects.toThrow('Cancelled');
    cancelled.abort();
    await rejection;
    expect(events).toEqual([]);
    read();
    const endChange = await change;
    expect(events).toEqual(['write']);
    endChange();
    first.release(); second.release();
  });

  it('serializes one session while allowing other readers to proceed', async () => {
    const scheduler = new TaskScheduler();
    const signal = new AbortController().signal;
    const first = await scheduler.acquire('a', false, signal);
    let started = false;
    const next = scheduler.acquire('a', false, signal).then((release) => { started = true; return release; });
    const other = await scheduler.acquire('b', false, signal);
    expect(started).toBe(false);
    first();
    const end = await next;
    end(); other();
  });
});
