import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TaskRequestSchema, TaskResultSchema, BatchRequestSchema } from '../orchestrator/contract.js';
import { createRuntime, type Runtime, type RuntimeOptions } from '../runtime.js';
import { VERSION } from '../version.js';

function failure(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
}

/** MCP is a thin adapter around the same executor used by the conversation. */
export function createMcpServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: 'handsfree', version: VERSION });
  server.registerTool('delegate', {
    description: 'Execute one bounded task. Specify agent to skip routing. Reuse requestId to avoid duplicate execution. Detailed output is fetched only when needed.',
    inputSchema: TaskRequestSchema,
    outputSchema: TaskResultSchema,
  }, async (request, extra) => {
    try {
      const result = await runtime.executor.execute(request, extra.signal);
      return { structuredContent: result, isError: result.status !== 'done', content: [
        { type: 'text', text: JSON.stringify(result) },
        { type: 'resource_link', uri: result.resultRef, name: `Task ${result.taskId} details`, mimeType: 'application/json' },
      ] };
    } catch (error) { return failure(error); }
  });
  server.registerTool('batch', {
    description: 'Execute a dependency graph. Independent inspections may overlap; changes run exclusively. Failed prerequisites block dependents. Identical sibling requests share one execution.',
    inputSchema: BatchRequestSchema,
  }, async (request, extra) => {
    try {
      const results = await runtime.executor.batch(request, extra.signal);
      return { structuredContent: { results }, isError: Object.values(results).some((r) => r.status !== 'done'),
        content: [{ type: 'text', text: JSON.stringify(results) }] };
    } catch (error) { return failure(error); }
  });
  server.registerTool('read_result', {
    description: 'Read a bounded page of a task result. Continue from nextOffset if present.',
    inputSchema: z.object({ taskId: z.number().int().positive(), offset: z.number().int().nonnegative().default(0), maxChars: z.number().int().min(1).max(32_000).default(8000) }),
    annotations: { readOnlyHint: true },
  }, async ({ taskId, offset, maxChars }) => {
    try { const result = runtime.executor.readResult(taskId, offset, maxChars);
      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) { return failure(error); }
  });
  server.registerTool('usage', { description: 'Inspect run token usage, frontier tokens, known USD cost and estimation gaps.', annotations: { readOnlyHint: true } }, async () => {
    const usage = runtime.usage.totals();
    return { structuredContent: usage, content: [{ type: 'text', text: JSON.stringify(usage) }] };
  });
  server.registerResource('task-result', new ResourceTemplate('handsfree://runs/{runId}/tasks/{taskId}', { list: undefined }),
    { description: 'First page of the full task result; use read_result for further pages.', mimeType: 'application/json' },
    async (uri, variables) => {
      if (variables.runId !== runtime.workspace.id || typeof variables.taskId !== 'string' || !/^[1-9]\d*$/.test(variables.taskId)) throw new Error('Unknown task result');
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(runtime.executor.readResult(Number(variables.taskId))) }] };
    });

  runtime.setEscalator({
    async ask(question) {
      if (!server.server.getClientCapabilities()?.elicitation) return false;
      const answer = await server.server.elicitInput({ mode: 'form', message: `${question.context.agentId}: ${question.summary}\n${question.detail}${question.approvalLabel ? `\n${question.approvalLabel}` : ''}`,
        requestedSchema: { type: 'object', properties: { allow: { type: 'boolean', title: question.approvalLabel ?? 'Allow this operation once?' } }, required: ['allow'] } }, { signal: question.signal });
      return answer.action === 'accept' && answer.content?.allow === true;
    },
    async input(question) {
      if (!server.server.getClientCapabilities()?.elicitation) return { action: 'cancel' };
      const properties: Record<string, PrimitiveSchemaDefinition> = {};
      for (const field of question.fields) {
        const base = { title: field.label, ...(field.description ? { description: field.description } : {}) };
        switch (field.kind) {
          case 'boolean': properties[field.key] = { type: 'boolean', ...base }; break;
          case 'number': case 'integer': properties[field.key] = { type: field.kind, ...base }; break;
          case 'enum': properties[field.key] = { type: 'string', ...base, enum: (field.options ?? []).map((option) => option.value) }; break;
          case 'multiselect': properties[field.key] = { type: 'array', ...base, items: { type: 'string', enum: (field.options ?? []).map((option) => option.value) } }; break;
          default: properties[field.key] = { type: 'string', ...base };
        }
      }
      const answer = await server.server.elicitInput({ mode: 'form', message: question.summary,
        requestedSchema: { type: 'object', properties, required: question.fields.filter((field) => field.required).map((field) => field.key) } }, { signal: question.signal });
      if (answer.action !== 'accept') return { action: answer.action === 'decline' ? 'decline' : 'cancel' };
      const content: Record<string, string | number | boolean | string[]> = {};
      for (const field of question.fields) {
        const value = answer.content?.[field.key];
        if (value !== undefined) content[field.key] = value;
      }
      return { action: 'accept', content };
    },
  });
  return server;
}

export async function serveMcp(options: RuntimeOptions): Promise<number> {
  const runtime = createRuntime(options);
  const server = createMcpServer(runtime);
  let closed!: () => void;
  const done = new Promise<void>((resolve) => { closed = resolve; });
  server.server.onclose = closed;
  const stop = () => { void server.close().finally(closed); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await server.connect(new StdioServerTransport()); await done; return 0; }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await runtime.close(); }
}
