import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../config/schema.js';
import { LocalModel } from './client.js';
import { routingRequest } from '../orchestrator/router.js';
import { metered } from '../orchestrator/usage.js';
import { BudgetManager } from '../orchestrator/budget.js';
import { Transcript } from '../workspace/transcript.js';

afterEach(() => vi.unstubAllGlobals());

describe('compatible HTTP routing client', () => {
  it('bounds output, strips private fields, preserves goals and accounts API/cache tokens', async () => {
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
    const manager = new BudgetManager(config, transcript);
    const llm = metered(new LocalModel(config.orchestration.local), 'plan', transcript, 'small', { manager, frontier: true, outputTokens: 64, contextTokens: 2048 });
    const route = routingRequest([{ agent: 'a', description: 'write code' }, { agent: 'b', description: 'translate' }], 'Translate', 2048);
    const reply = await llm.chat([...route.messages, { role: 'user', content: 'Keep names', pinned: true, requiredContent: 'Keep names' }], { schema: route.schema, maxOutputTokens: 64 });
    expect(route.parse(reply)).toBe('b');
    expect(sent.max_tokens).toBe(64);
    expect(sent.messages).toEqual([
      { role: 'system', content: route.messages[0]!.content }, { role: 'user', content: 'Translate\n\nKeep names' },
    ]);
    expect(manager.totals()).toMatchObject({ tokens: 107, frontierTokens: 107, estimatedCalls: 0 });
    expect(transcript.all().find((r) => r.type === 'budget_usage')).toMatchObject({ usage: { inputTokens: 60, cachedReadTokens: 40 } });
    manager.close();
  });
});
