import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { ConfigSchema } from '../src/config/schema.js';
import { createRuntime } from '../src/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-controls-'));
const config = ConfigSchema.parse({ ...loadConfig().config, workspaceRoot: root, cleanupPeriodDays: 0,
  orchestration: { ...loadConfig().config.orchestration, provider: 'local' },
});
// This check exercises the explicit opt-out; native execution defaults to allow.
config.agents.codex!.nativeTools = 'deny';
const runtime = createRuntime({ config, permissionMode: 'bypass' });
const checks: { name: string; ok: boolean; detail: unknown }[] = [];
function check(name: string, ok: boolean, detail: unknown) { checks.push({ name, ok, detail }); console.log(JSON.stringify(checks.at(-1))); }
try {
  let refused = '';
  try { await runtime.executor.execute({ agent: 'codex', task: 'Create forbidden.txt', kind: 'change' }); }
  catch (error) { refused = String(error); }
  check('Codex refused before launch or billing', refused.includes('outside host policy') && !runtime.pool.isOpen('codex') && runtime.usage.totals().tokens === 0, refused);
  const result = await runtime.executor.execute({
    task: 'Write result.csv from these rows: B=3, A=2, B=4. Aggregate by customer in first-seen order. Exact output: header customer,total followed by B,7 and A,2, with LF newlines and one trailing newline.',
    constraints: ['Only result.csv may be created. Do not run commands.'], kind: 'change', requestId: 'local-route-csv',
  });
  const output = fs.existsSync(path.join(runtime.workspace.dir, 'result.csv')) ? fs.readFileSync(path.join(runtime.workspace.dir, 'result.csv'), 'utf8') : '';
  const planning = runtime.transcript.all().flatMap((record) => record.type === 'budget_usage' && record.usage.source === 'orchestrator' ? [record.usage] : []);
  check('Local selector delegates a real worker', result.status === 'done' && output === 'customer,total\nB,7\nA,2\n', { result, output });
  check('Routing records local tokens', planning.length === 1 && planning[0]!.frontierTokens === 0, planning);
} finally {
  const evidence = { root, workspace: runtime.workspace.dir, checks, usage: runtime.usage.totals() };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(evidence, null, 2));
  await runtime.close(); console.log(`Evidence: ${path.join(root, 'report.json')}`);
  if (checks.some((item) => !item.ok) || checks.length < 3) process.exitCode = 1;
}
