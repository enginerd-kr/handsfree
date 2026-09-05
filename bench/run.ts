import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';
import { createRuntime } from '../src/runtime.js';
import { estimateTokens, type ChatClient } from '../src/brain/client.js';
import { tokensOf } from '../src/orchestrator/usage.js';
import { taskBrief, TaskRequestSchema } from '../src/orchestrator/contract.js';
import { fakeAgent, type Act } from '../test/fake-agent.js';

type Mode = 'direct' | 'conversation' | 'structured';
export interface BenchmarkRow {
  mode: Mode;
  tasks: number;
  successes: number;
  totalTokens: number;
  frontierTokens: number;
  plannerTokens: number;
  plannerCalls: number;
  workerCalls: number;
  failedCalls: number;
  estimatedCalls: number;
  knownCostUsd: number;
  unknownCostCalls: number;
  durationMs: number;
  errors: string[];
}
interface Order { customer: string; amount: number; cancelled?: boolean }
const INPUTS: Order[][] = [
  [{ customer: 'B', amount: 3 }, { customer: 'A', amount: 2 }, { customer: 'B', amount: 4 }, { customer: 'C', amount: 9, cancelled: true }],
  [{ customer: 'B', amount: 3 }, { customer: 'A', amount: 2 }, { customer: 'B', amount: 4 }, { customer: 'A', amount: -1 }, { customer: 'C', amount: 9, cancelled: true }],
];
const EXPECTED = [[{ customer: 'B', total: 7 }, { customer: 'A', total: 2 }], [{ customer: 'B', total: 7 }, { customer: 'A', total: 1 }]];

export async function benchmark(live = false): Promise<{ mode: 'simulation' | 'live'; rows: BenchmarkRow[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-benchmark-'));
  const rows: BenchmarkRow[] = [];
  try {
    const configured = live ? loadConfig().config : ConfigSchema.parse({ agents: { worker: { command: 'unused' } } });
    const agentId = configured.orchestration.provider === 'acp' ? configured.orchestration.acp.agent : Object.keys(configured.agents)[0]!;
    const profile = configured.agents[agentId];
    if (!profile) throw new Error('No benchmark worker configured');
    // All three modes use the same worker/model. In ACP mode use the explicitly configured small planner model.
    const model = configured.orchestration.provider === 'acp' ? configured.orchestration.acp.model ?? profile.model : profile.model;
    for (const mode of ['direct', 'conversation', 'structured'] as const) {
      const config: Config = ConfigSchema.parse({ ...structuredClone(configured), workspaceRoot: root, cleanupPeriodDays: 0,
        agents: { [agentId]: { ...profile, model } }, roles: { [agentId]: 'workspace data transformation' },
      });
      let dir = '';
      const worker = fakeAgent({ script: (prompt) => {
        const orders = JSON.parse(fs.readFileSync(path.join(dir, 'orders.json'), 'utf8')) as Order[];
        const totals = new Map<string, number>();
        for (const order of orders) if (!order.cancelled) totals.set(order.customer, (totals.get(order.customer) ?? 0) + order.amount);
        const output = JSON.stringify([...totals].map(([customer, total]) => ({ customer, total })));
        const text = 'Aggregated active orders in first-seen order.\nREPORT\noutcome: done\nsummary: Wrote totals.json, excluding cancelled orders.\nchanged: totals.json\nverify: compare totals to orders';
        const inputTokens = estimateTokens(JSON.stringify(prompt)) + 3000;
        const acts: Act[] = [
          { do: 'tool', toolCallId: 'read', title: 'Read orders', kind: 'read', locations: [path.join(dir, 'orders.json')] },
          { do: 'write', path: path.join(dir, 'totals.json'), content: output, onResult: () => {} },
          { do: 'say', text },
          { do: 'stop', reason: 'end_turn', usage: { inputTokens, outputTokens: estimateTokens(text), totalTokens: inputTokens + estimateTokens(text) } },
        ];
        return acts;
      } });
      const llm: ChatClient = { async chat(messages, options) {
        const last = messages.at(-1)?.content ?? '';
        const reply = options?.schema?.name === 'handsfree_route' ? JSON.stringify({ agent: agentId })
          : last.startsWith('TOOL RESULT') ? JSON.stringify({ action: 'answer', message: 'Updated totals.json.' })
          : JSON.stringify({ action: 'call', tool: 'agent', input: { agent: agentId, kind: 'change', prompt: last } });
        options?.onUsage?.({ promptTokens: messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0)
          + (options?.schema ? estimateTokens(JSON.stringify(options.schema.schema)) : 0), completionTokens: estimateTokens(reply) });
        return reply;
      } };
      const runtime = createRuntime({ config, permissionMode: 'bypass', ...(live ? {} : { llm, createTarget: () => worker.target() }) });
      dir = runtime.workspace.dir;
      const started = Date.now();
      let successes = 0;
      const errors: string[] = [];
      try {
        for (const [index, orders] of INPUTS.entries()) {
          fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(orders));
          const request = TaskRequestSchema.parse({
            task: index === 0 ? 'Read orders.json and write totals.json as an array of objects with customer and total.' : 'orders.json changed. Recompute totals.json using the same rules.',
            constraints: ['Exclude cancelled orders.', 'Sum amounts per customer.', 'Preserve first-seen customer order.', 'Change only totals.json.'],
            acceptanceCriteria: ['totals.json is valid JSON with exact customer totals.'], files: ['orders.json', 'totals.json'],
          });
          if (mode === 'direct') {
            const session = await runtime.pool.session(agentId);
            const brief = taskBrief(request);
            let failed = true;
            let counted: Awaited<ReturnType<typeof session.prompt>> | undefined;
            const before = runtime.transcript.all().length;
            try {
              counted = await session.prompt(brief, { turnTimeoutMs: 120_000, idleTimeoutMs: 60_000, cancelGraceMs: 3000 });
              failed = counted.stopReason !== 'end_turn';
            } finally {
              const chunks = runtime.transcript.all().slice(before).flatMap((record) => record.type === 'session_update'
                && record.update.sessionUpdate === 'agent_message_chunk' && record.update.content.type === 'text' ? [record.update.content.text] : []).join('');
              runtime.usage.record(agentId, session.currentModel() ?? agentId, profile.frontier, { tokens: counted?.usage ? tokensOf(counted.usage) : estimateTokens(brief + chunks), inputTokens: counted?.usage?.inputTokens ?? estimateTokens(brief),
                outputTokens: counted?.usage ? counted.usage.outputTokens + (counted.usage.thoughtTokens ?? 0) : estimateTokens(chunks), cachedReadTokens: counted?.usage?.cachedReadTokens,
                cachedWriteTokens: counted?.usage?.cachedWriteTokens, estimated: counted?.usage === undefined }, failed);
            }
          } else if (mode === 'conversation') await runtime.conversation.send(taskBrief(request));
          else await runtime.executor.execute(request);
          try { if (JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'totals.json'), 'utf8'))) === JSON.stringify(EXPECTED[index])) successes++; }
          catch { /* A missing or invalid artifact is a quality failure, not a skipped sample. */ }
        }
      } catch (error) {
        errors.push((error as Error).message);
      } finally {
        const totals = runtime.usage.totals();
        const usage = runtime.transcript.all().flatMap((r) => r.type === 'budget_usage' ? [r.usage] : []);
        rows.push({ mode, tasks: INPUTS.length, successes, totalTokens: totals.tokens, frontierTokens: totals.frontierTokens,
          plannerTokens: usage.filter((u) => u.source === 'orchestrator').reduce((n, u) => n + u.tokens, 0),
          plannerCalls: usage.filter((u) => u.source === 'orchestrator').length,
          workerCalls: usage.filter((u) => u.source !== 'orchestrator').length, failedCalls: usage.filter((u) => u.failed).length,
          estimatedCalls: totals.estimatedCalls, knownCostUsd: totals.costUsd, unknownCostCalls: totals.unknownCostCalls, durationMs: Date.now() - started, errors });
        if (live) process.stderr.write(`${mode}: ${successes}/${INPUTS.length} artifacts verified; ${totals.tokens} tokens${errors.length ? `; ${errors.join('; ')}` : ''}\n`);
        await runtime.close();
      }
    }
    return { mode: live ? 'live' : 'simulation', rows };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const live = process.argv.includes('--live');
  benchmark(live).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.rows.some((row) => row.successes !== row.tasks)) process.exitCode = 1;
  }).catch((error) => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
}
