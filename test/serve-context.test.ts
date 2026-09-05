import { describe, expect, it } from 'vitest';
import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createServeApp } from '../src/commands/serve.js';
import { harness, scriptedModel } from './harness.js';
import { fakeAgent } from './fake-agent.js';

describe('ACP content delivery', () => {
  it('delivers embedded text to the worker and the full answer to the caller', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'FULL_ANSWER: preserve retry order.\nREPORT\noutcome: done\nsummary: Reviewed retries' }] });
    const h = harness({ agents: { a }, llm: scriptedModel([]) });
    const served = createServeApp(h.runtime.config, { llm: scriptedModel([]), createTarget: () => a.target() });
    const updates: string[] = [];
    try {
      await client({ name: 'editor' }).onNotification(methods.client.session.update, (ctx) => { updates.push(JSON.stringify(ctx.params.update)); })
        .connectWith(served.app, async (ctx) => {
          await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
          const session = await ctx.request(methods.agent.session.new, { cwd: h.workspaceDir, mcpServers: [] });
          await ctx.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [
            { type: 'text', text: '@a inspect this' },
            { type: 'resource', resource: { uri: 'file:///context.txt', mimeType: 'text/plain', text: 'EMBEDDED_CONSTRAINT: preserve order' } },
          ] });
        });
      expect(a.prompts[0]).toContain('EMBEDDED_CONSTRAINT');
      expect(updates.join('')).toContain('FULL_ANSWER');
    } finally { await served.dispose(); await h.dispose(); }
  });
});
