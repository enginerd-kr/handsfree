import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/commands/mcp.js';
import { harness, type Harness } from './harness.js';
import { fakeAgent } from './fake-agent.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function connect(h: Harness) {
  cleanup.push(() => h.dispose());
  const server = createMcpServer(h.runtime);
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe('MCP tools', () => {
  it('exposes typed delegation and returns a reference to the complete answer', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'ESSENTIAL DETAIL: preserve ordering.\nREPORT\noutcome: done\nsummary: Reviewed ordering' }] });
    const h = harness({ agents: { a } });
    const client = await connect(h);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['delegate', 'batch', 'read_result', 'usage']);
    const result = await client.callTool({ name: 'delegate', arguments: { task: 'review', agent: 'a', kind: 'inspect' } });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ status: 'done', summary: 'Reviewed ordering' });
    const details = await client.callTool({ name: 'read_result', arguments: { taskId: 1 } });
    expect(JSON.stringify(details)).toContain('ESSENTIAL DETAIL');
    const data = result.structuredContent as { resultRef: string };
    const resource = await client.readResource({ uri: data.resultRef });
    expect(JSON.stringify(resource)).toContain('ESSENTIAL DETAIL');
    const usage = await client.callTool({ name: 'usage' });
    expect(usage.structuredContent).toMatchObject({ estimatedCalls: 1 });
  });

  it('does not expose results outside the current run and returns failed status to callers', async () => {
    const a = fakeAgent({ script: () => [{ do: 'say', text: 'REPORT\noutcome: blocked\nsummary: Need key\nopen: - missing key' }] });
    const client = await connect(harness({ agents: { a } }));
    const result = await client.callTool({ name: 'delegate', arguments: { task: 'go', agent: 'a' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'blocked', blockers: ['missing key'] });
    await expect(client.readResource({ uri: 'handsfree://runs/other/tasks/1' })).rejects.toThrow('Unknown task result');
    const invalid = await client.callTool({ name: 'read_result', arguments: { taskId: -1 } });
    expect(invalid.isError).toBe(true);
  });

  it('cancels a running delegation on MCP request cancellation', async () => {
    const a = fakeAgent({ script: () => [{ do: 'stall', ms: 200 }, { do: 'say', text: 'not completed' }] });
    const h = harness({ agents: { a } });
    const client = await connect(h);
    const abort = new AbortController();
    const pending = client.callTool({ name: 'delegate', arguments: { task: 'wait', agent: 'a' } }, undefined, { signal: abort.signal });
    await new Promise<void>((resolve) => {
      const listener = () => { if (a.prompts.length) { clearInterval(timer); resolve(); } };
      const timer = setInterval(listener, 5);
    });
    abort.abort();
    await expect(pending).rejects.toThrow();
    await h.runtime.executor.close();
    expect(h.runtime.transcript.all().find((r) => r.type === 'stop')).toMatchObject({ status: 'cancelled' });
  });
});
