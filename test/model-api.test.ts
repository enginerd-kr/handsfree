import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { LocalModel } from '../src/models/client.js';
import { routingRequest } from '../src/orchestrator/execution/router.js';
import { metered } from '../src/orchestrator/usage/usage.js';
import { UsageTracker } from '../src/orchestrator/usage/meter.js';
import { Transcript } from '../src/workspace/transcript.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('compatible HTTP routing client', () => {
  it('does not add an SDK deadline and still propagates caller cancellation', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      entered();
      return new Promise<Response>((_, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    });
    const llm = new LocalModel(ConfigSchema.parse({}).orchestration.local);
    const controller = new AbortController();
    const work = llm.chat([{ role: 'user', content: 'Take your time.' }], { signal: controller.signal });
    const rejected = expect(work).rejects.toThrow(/abort/i);
    await started;
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(requestSignal?.aborted).toBe(false);
    controller.abort();
    await rejected;
  });

  it('preserves full output, strips private fields, preserves goals and accounts API/cache tokens', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      const packets = [
        { choices: [{ delta: { content: '{"agent":"1"}' } }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } } },
      ];
      return new Response(packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    });
    const config = ConfigSchema.parse({ orchestration: { provider: 'api' } });
    const transcript = new Transcript();
    const manager = new UsageTracker(config, transcript);
    const llm = metered(new LocalModel(config.orchestration.local), 'plan', transcript, 'small', { manager, frontier: true });
    const route = routingRequest([{ agent: 'a', description: 'write code' }, { agent: 'b', description: 'translate' }], 'Translate');
    const reply = await llm.chat([...route.messages, { role: 'user', content: 'Keep names', pinned: true, requiredContent: 'Keep names' }], { schema: route.schema, });
    expect(route.parse(reply)).toBe('b');
    expect(sent).not.toHaveProperty('max_tokens');
    expect(sent.messages).toEqual([
      { role: 'system', content: route.messages[0]!.content }, { role: 'user', content: 'Translate\n\nKeep names' },
    ]);
    expect(manager.totals()).toMatchObject({ tokens: 107, frontierTokens: 107, estimatedCalls: 0 });
    expect(transcript.all().find((r) => r.type === 'budget_usage')).toMatchObject({ usage: { inputTokens: 60, cachedReadTokens: 40 } });
    manager.close();
  });
});
