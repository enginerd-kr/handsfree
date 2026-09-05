import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ConfigSchema } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';
import { createRuntime } from '../src/runtime.js';
import { createMcpServer } from '../src/servers/mcp.js';
import type { TaskResult } from '../src/contracts/task.js';
import { sessionMemory } from '../src/orchestrator/context/memory.js';

// Explicit live integration suite. Never imported by the unit test runner.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-use-cases-'));
const configured = loadConfig().config;
// This suite intentionally exercises native Codex tools in a disposable fixture.
// The opt-in is explicit because the host cannot mediate all those operations.
if (process.argv.includes('--allow-native')) configured.agents.codex!.nativeTools = 'allow';
const config = ConfigSchema.parse({ ...configured, workspaceRoot: root, cleanupPeriodDays: 0,
  capabilities: { ...configured.capabilities, terminal: true },
});
const runtime = createRuntime({ config, permissionMode: 'bypass' });
const workspace = runtime.workspace.dir;
const report: Record<string, unknown> = { date: new Date().toISOString(), root, workspace, runId: runtime.workspace.id,
  configurationChanges: ['isolated workspace', 'terminal enabled'],
  agents: {}, cases: [], completed: false };
const cases = report.cases as { name: string; ok: boolean; detail: unknown }[];
function save() { fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); }
function check(name: string, ok: boolean, detail: unknown) {
  cases.push({ name, ok, detail }); save(); process.stderr.write(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}\n`);
}
function file(name: string, text: string) { const target = path.join(workspace, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
function read(name: string) { try { return fs.readFileSync(path.join(workspace, name), 'utf8'); } catch { return ''; } }
function workerCalls() { return runtime.transcript.all().filter((r) => r.type === 'delegation').length; }
function planningCalls() { return runtime.transcript.all().filter((r) => r.type === 'budget_usage' && r.usage.source === 'orchestrator').length; }

file('package.json', JSON.stringify({ name: 'order-summary-fixture', type: 'module', scripts: { test: 'node --test' } }));
const requirements = `The public summarize(orders) function returns [{customer,total}] in first-seen ACTIVE customer order.
Ignore cancelled orders. Sum integer amounts, including negative amounts. Empty input returns [].
Customer names are opaque strings: '__proto__' and 'constructor' must work. Never mutate input.
Preserve the named export and avoid dependencies. Only src/summarize.js may change during the fix.
`;
file('REQUIREMENTS.md', requirements);
file('src/summarize.js', `export function summarize(orders) {
  const totals = {};
  for (const order of orders) totals[order.customer] = (totals[order.customer] || 0) + order.amount;
  return Object.keys(totals).sort().map(customer => ({ customer, total: totals[customer] }));
}
`);
const tests = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './src/summarize.js';
test('first-seen order and cancellation', () => assert.deepEqual(summarize([
 {customer:'B',amount:3},{customer:'A',amount:2},{customer:'B',amount:4},{customer:'C',amount:99,cancelled:true}
]), [{customer:'B',total:7},{customer:'A',total:2}]));
test('negative and empty inputs', () => { assert.deepEqual(summarize([{customer:'A',amount:3},{customer:'A',amount:-4}]),[{customer:'A',total:-1}]); assert.deepEqual(summarize([]),[]); });
test('opaque customer keys', () => assert.deepEqual(summarize([{customer:'__proto__',amount:2},{customer:'constructor',amount:3}]), [{customer:'__proto__',total:2},{customer:'constructor',total:3}]));
test('does not mutate input', () => { const orders=Object.freeze([Object.freeze({customer:'A',amount:1})]); assert.deepEqual(summarize(orders),[{customer:'A',total:1}]); });
test('cancelled first occurrence does not set order', () => assert.deepEqual(summarize([{customer:'A',amount:9,cancelled:true},{customer:'B',amount:2},{customer:'A',amount:3}]),[{customer:'B',total:2},{customer:'A',total:3}]));
`;
file('summary.test.js', tests);
const baseline = read('src/summarize.js');
const originalFiles = new Map(['package.json', 'REQUIREMENTS.md', 'summary.test.js'].map((name) => [name, read(name)]));
process.stderr.write(`Evidence directory: ${root}\n`); save();

const server = createMcpServer(runtime);
const client = new Client({ name: 'handsfree-live-use-cases', version: '1' });
const [left, right] = InMemoryTransport.createLinkedPair();
async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
}
async function delegate(args: Record<string, unknown>): Promise<TaskResult | undefined> {
  const response = await call('delegate', args);
  if (!response.structuredContent) { check('delegate response available', false, response.content); return; }
  return response.structuredContent as TaskResult;
}
try {
  await server.connect(right); await client.connect(left);
  const opened = await Promise.allSettled(['claude', 'gemini', 'codex'].map(async (agent) => {
    const session = await runtime.pool.session(agent);
    const connection = await runtime.pool.connection(agent);
    return { agent, sessionId: session.sessionId, model: session.currentModel(), models: session.models().map((m) => m.value), adapter: connection.description };
  }));
  report.agents = opened.map((result, index) => result.status === 'fulfilled' ? result.value : { agent: ['claude', 'gemini', 'codex'][index], error: String(result.reason) });
  check('three real ACP sessions', opened.every((r) => r.status === 'fulfilled'), report.agents);

  // A new run makes the three candidates tie: exercise the small selector as well as explicit routing.
  const beforeRoute = planningCalls();
  const routed = await delegate({ task: 'Reply with ROUTING_OK in your final prose. No file access or commands are needed.', kind: 'answer' });
  const routedDetail = routed ? runtime.executor.readResult(routed.taskId).text : '';
  const expectedRoutingCalls = config.execution.routing === 'deterministic' || config.execution.routing === 'auto' && config.orchestration.provider === 'acp' ? 0 : 1;
  check('bounded automatic routing', routed?.status === 'done' && routedDetail.includes('ROUTING_OK') && planningCalls() - beforeRoute === expectedRoutingCalls,
    { result: routed, plannerCalls: planningCalls() - beforeRoute });

  const beforeBatch = planningCalls();
  const batch = await call('batch', { tasks: [
    { id: 'code-review', request: { agent: 'claude', kind: 'inspect', task: 'Read src/summarize.js and REQUIREMENTS.md. Identify concrete defects with a minimal counterexample. Put the key defect in your REPORT summary.',
      constraints: ['Read-only. Use file reading tools; no commands or edits.'], files: ['src/summarize.js', 'REQUIREMENTS.md'] } },
    { id: 'test-review', request: { agent: 'gemini', kind: 'inspect', task: 'Read summary.test.js and REQUIREMENTS.md. Explain the required behavior, especially opaque customer keys and cancellation. Put the key acceptance condition in your REPORT summary.',
      constraints: ['Read-only. Use file reading tools; no commands or edits.'], files: ['summary.test.js', 'REQUIREMENTS.md'] } },
    { id: 'fix', dependsOn: ['code-review', 'test-review'], request: { agent: 'codex', kind: 'change', task: 'Apply the prerequisite findings and fix src/summarize.js. Run node --test summary.test.js to verify.',
      constraints: [requirements, 'Do not modify package.json, REQUIREMENTS.md or summary.test.js.'],
      acceptanceCriteria: ['All existing tests pass without changing tests.'], files: ['src/summarize.js', 'summary.test.js'], requestId: 'fix-order-summary' } },
  ] });
  const results = (batch.structuredContent as { results?: Record<string, TaskResult> } | undefined)?.results ?? {};
  check('three-agent review-to-fix dependency graph', ['code-review', 'test-review', 'fix'].every((id) => results[id]?.status === 'done'), results);
  check('Codex change and verification metadata', results.fix?.artifacts?.includes(path.join(workspace, 'src/summarize.js')) === true
    && results.fix.verification?.source === 'agent_report' && results.fix.verification.detail.includes('node --test'), results.fix);
  check('explicit graph skips planner', planningCalls() === beforeBatch, { plannerCalls: planningCalls() - beforeBatch });
  const records = runtime.transcript.all();
  const reviews = records.filter((r) => r.type === 'delegation' && (r.agentId === 'claude' || r.agentId === 'gemini') && r.task.includes('Read '));
  const reviewStops = records.filter((r) => r.type === 'stop' && reviews.some((d) => d.type === 'delegation' && d.taskId === r.taskId));
  const fixStart = records.find((r) => r.type === 'delegation' && r.agentId === 'codex');
  check('read overlap and dependency ordering', reviews.length === 2 && reviewStops.length === 2 && Math.max(...reviews.map((r) => r.seq)) < Math.min(...reviewStops.map((r) => r.seq))
    && !!fixStart && fixStart.seq > Math.max(...reviewStops.map((r) => r.seq)),
    { starts: reviews.map((r) => r.seq), stops: reviewStops.map((r) => r.seq), fix: fixStart?.seq });
  check('protected inputs unchanged', [...originalFiles].every(([name, content]) => read(name) === content), { sourceChanged: read('src/summarize.js') !== baseline });
  // Host-owned copy outside the agent workspace prevents edited tests producing false passes.
  const hostTests = path.join(root, 'host-checks.mjs');
  fs.writeFileSync(hostTests, tests.replace("'./src/summarize.js'", JSON.stringify(path.join(workspace, 'src/summarize.js'))));
  try {
    const output = execFileSync(process.execPath, ['--test', hostTests], { encoding: 'utf8', timeout: 15_000 });
    fs.writeFileSync(path.join(root, 'host-tests.txt'), output); check('independent artifact tests', true, output);
  } catch (error) {
    const output = (error as { stdout?: string }).stdout ?? String(error); fs.writeFileSync(path.join(root, 'host-tests.txt'), output);
    check('independent artifact tests', false, output);
  }

  const beforeDuplicate = workerCalls();
  const exportRequest = { task: 'Read orders.json. Write totals.csv with exactly header customer,total followed by active customer totals in first-seen order. Use LF newlines, with one trailing newline. Only totals.csv may change.',
    agent: 'gemini', kind: 'change', files: ['orders.json'], requestId: 'export-csv' };
  file('orders.json', JSON.stringify([{ customer: 'B', amount: 3 }, { customer: 'A', amount: 2 }, { customer: 'B', amount: 4 }, { customer: 'X', amount: 99, cancelled: true }]));
  const [exported, duplicate] = await Promise.all([delegate(exportRequest), delegate(exportRequest)]);
  check('Gemini CSV artifact and concurrent idempotency', exported?.status === 'done' && exported.taskId === duplicate?.taskId && workerCalls() - beforeDuplicate === 1
    && read('totals.csv') === 'customer,total\nB,7\nA,2\n', { exported, duplicateTaskId: duplicate?.taskId, workerCalls: workerCalls() - beforeDuplicate, csv: read('totals.csv') });

  const sessionBefore = runtime.pool.sessionId('gemini');
  file('orders.json', JSON.stringify([{ customer: 'B', amount: 10 }, { customer: 'A', amount: -2 }]));
  const stale = sessionMemory(runtime.transcript, 'gemini', sessionBefore).stale;
  const updated = await delegate({ ...exportRequest, requestId: 'export-updated', task: 'orders.json has changed on disk. Re-read it and regenerate totals.csv with the exact same formatting and aggregation rules. Only totals.csv may change.' });
  check('session reuse rereads changed input', updated?.status === 'done' && runtime.pool.sessionId('gemini') === sessionBefore
    && stale.includes(path.join(workspace, 'orders.json')) && read('totals.csv') === 'customer,total\nB,10\nA,-2\n',
    { updated, reused: runtime.pool.sessionId('gemini') === sessionBefore, stale, csv: read('totals.csv') });

  const blockedBatch = await call('batch', { tasks: [
    { id: 'missing-input', request: { agent: 'claude', kind: 'inspect', task: 'Read missing-production-schema.json to validate a migration. If the file is missing, report outcome blocked with the missing file in open; do not invent a schema or create files. Use file reading tools only.' } },
    { id: 'must-not-run', dependsOn: ['missing-input'], request: { agent: 'codex', task: 'Write must-not-exist.txt containing DEPENDENCY_FAILURE.' } },
  ] });
  const blocked = (blockedBatch.structuredContent as { results?: Record<string, TaskResult> } | undefined)?.results ?? {};
  check('real missing prerequisite blocks changes', blocked['missing-input']?.status === 'blocked' && blocked['must-not-run']?.status === 'blocked'
    && !fs.existsSync(path.join(workspace, 'must-not-exist.txt')), blocked);

  if (exported) {
    let offset: number | undefined = 0, full = '', pages = 0;
    while (offset !== undefined && pages < 100) {
      const response = await call('read_result', { taskId: exported.taskId, offset, maxChars: 300 });
      const page = response.structuredContent as { text: string; nextOffset?: number };
      full += page.text; offset = page.nextOffset; pages++;
    }
    const result = JSON.parse(full) as { taskId: number; message: string };
    check('MCP full-result pagination', result.taskId === exported.taskId && !!result.message && pages > 1, { pages, chars: full.length });
  }
  report.completed = true;
} catch (error) { check('suite completed', false, String(error)); }
finally {
  report.usage = runtime.usage.totals();
  report.charges = runtime.transcript.all().flatMap((r) => r.type === 'budget_usage' ? [r.usage] : []);
  report.denials = runtime.transcript.all().flatMap((r) => r.type === 'decision' && r.entry.verdict === 'deny' ? [{ agent: r.agentId, rule: r.entry.rule, summary: r.entry.summary, reason: r.entry.reason }] : []);
  save();
  await client.close(); await server.close(); await runtime.close();
  process.stderr.write(`Saved evidence: ${path.join(root, 'report.json')}\n`);
  if (cases.some((item) => !item.ok)) process.exitCode = 1;
}
