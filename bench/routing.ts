import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { LocalModel, type Usage } from '../src/brain/client.js';
import { routingRequest } from '../src/orchestrator/router.js';

// Only the selector makes model calls. No coding agents are launched.
const { config } = loadConfig();
const model = process.argv[2] ?? 'google/gemma-3-4b';
const llm = new LocalModel({ ...config.orchestration.local, model, timeoutMs: 90_000 });
const candidates = [
  { agent: 'claude', description: 'Implement multi-file application features and API changes.' },
  { agent: 'gemini', description: 'Translate documentation and transform bulk text or CSV data.' },
  { agent: 'codex', description: 'Diagnose failing tests, write regression tests and refactor code.' },
];
const samples = [
  ['Implement a new REST endpoint across routes, service, and storage modules.', 'claude'],
  ['Translate the README and release notes into Korean.', 'gemini'],
  ['Fix the failing parser test and add a regression test for empty tokens.', 'codex'],
  ['라우트, 서비스, 저장소 세 모듈에 걸쳐 새 API 기능을 구현해줘.', 'claude'],
  ['CSV 데이터 1000행을 정규화하고 한국어 문서를 영어로 번역해줘.', 'gemini'],
  ['실패하는 테스트 원인을 찾고 회귀 테스트를 추가해줘.', 'codex'],
  ['Add account preferences with changes in the controller, business logic, and database adapter.', 'claude'],
  ['Convert the customer export from TSV to CSV and normalize whitespace.', 'gemini'],
  ['Refactor duplicated validation code while preserving behavior with regression tests.', 'codex'],
  ['주문 취소 API를 컨트롤러와 서비스, DB 계층에 추가해줘.', 'claude'],
  ['영문 릴리스 노트를 한국어로 번역하고 마크다운 형식을 정리해줘.', 'gemini'],
  ['간헐적으로 깨지는 동시성 테스트를 진단하고 재현 테스트를 작성해줘.', 'codex'],
];
const rows: unknown[] = [];
const file = path.join(os.tmpdir(), `handsfree-routing-${Date.now()}.json`);
let failures = 0;
for (const [task, expected] of samples) {
  const started = Date.now();
  let usage: Usage | undefined, reply = '', error: string | undefined, agent: string | undefined;
  try {
    const request = routingRequest(candidates, task!, 2048);
    reply = await llm.chat(request.messages, { schema: request.schema, maxOutputTokens: request.maxOutputTokens,
      onUsage: (count) => { usage = count; }, onDelta: () => {} });
    agent = request.parse(reply);
  } catch (err) { error = String(err); }
  const ok = agent === expected;
  if (!ok) failures++;
  const row = { task, expected, agent, ok, usage, reply, error, durationMs: Date.now() - started };
  rows.push(row); console.log(JSON.stringify(row));
  fs.writeFileSync(file, JSON.stringify({ model, endpoint: config.orchestration.local.baseURL, rows }, null, 2));
}
console.log(`Evidence: ${file}`);
if (failures) process.exitCode = 1;
