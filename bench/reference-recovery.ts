import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { orchestrationModel } from '../src/config/schema.js';
import { AcpModel } from '../src/models/acp.js';
import { LocalModel, type ChatClient } from '../src/models/client.js';
import { Transcript } from '../src/workspace/transcript.js';
import { fakeAgent } from '../test/fake-agent.js';
import { harness } from '../test/harness.js';

// Real configured planner, fixture workers. The recovery scenario replays the
// original failed-call prefix before asking the model what to do next. Replay
// and count assertions are test-only; production has no completion gate.
const config = loadConfig().config;
const provider = process.argv.includes('--local') ? 'local' : config.orchestration.provider;
const replayMissingSelection = process.argv.includes('--missing-shared-context');
const checkShared = replayMissingSelection || process.argv.includes('--shared-context');
const modelOverride = process.argv.find((arg) => arg.startsWith('--model='))?.slice(8);
const modelName = modelOverride ?? (provider === 'acp'
  ? orchestrationModel(config) : config.orchestration.local.model);
const reportFile = path.join(os.tmpdir(), `handsfree-reference-check-${Date.now()}.json`);
const evidence = { provider, model: modelName, checkShared, replayMissingSelection, scenarios: [] as unknown[], passed: false };

async function scenario(injectFault: boolean) {
  const label = replayMissingSelection ? 'missing-shared-context' : injectFault ? 'invalid-reference' : 'baseline';
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-reference-project-'));
  const agents = {
    claude: fakeAgent({ script: (_prompt, turn) => [{ do: 'say', text: [
      'CLAUDE_REPLY_1: JS는 브라우저에서 직접 실행되고 프론트와 서버에서 같은 언어를 쓸 수 있어 웹 개발에 유리합니다.',
      'CLAUDE_REPLY_2: Python의 데이터 생태계에는 동의합니다. 하지만 브라우저 UI가 필요한 제품은 JS가 필요하므로 제품 전체 맥락에서 선택해야 합니다.',
      'CLAUDE_REPLY_3: Python의 분석 능력과 JS의 사용자 화면 구현은 보완적입니다. 웹 중심이면 JS부터, 분석 중심이면 Python부터 시작하자는 결론입니다.',
    ][turn] ?? `CLAUDE_EXTRA_REPLY_${turn + 1}` }] }),
    codex: fakeAgent({ script: (_prompt, turn) => [{ do: 'say', text: [
      'CODEX_REPLY_1: Python은 데이터 분석, 머신러닝, 자동화에 유리합니다. 읽기 쉬운 문법과 풍부한 분석 라이브러리가 장점입니다.',
      'CODEX_REPLY_2: JS의 브라우저 장점에는 동의하지만 분석 도구나 자동화에는 Python이 더 직접적입니다. 웹이 없는 프로젝트까지 JS를 우선할 이유는 없습니다.',
      'CODEX_REPLY_3: 용도에 따라 선택하자는 결론에 동의합니다. 분석과 자동화는 Python, 브라우저 중심은 JS, 복합 제품은 둘을 함께 쓰는 것이 좋습니다.',
    ][turn] ?? `CODEX_EXTRA_REPLY_${turn + 1}` }] }),
  };
  let model: ChatClient & { close?: () => Promise<void> };
  let injected = false;
  const calls: { source: 'model' | 'replay'; reply: string; injectedReply?: string; toolResults: string[] }[] = [];
  const llm: ChatClient = { async chat(messages, options) {
    if (calls.length >= 20) throw new Error('Benchmark watchdog: more than 20 planner calls.');
    const source = (replayMissingSelection && calls.length === 0) || (injectFault && calls.length < 3) ? 'replay' : 'model';
    const replayCall = (refs: string[]) => JSON.stringify({ message: '', finish: false,
      calls: [{ tool: 'agent', input: { agent: ['claude', 'codex'], kind: 'answer',
        prompt: calls.length === 0 ? 'JS와 Python의 장단점에 관한 첫 입장을 밝혀줘.'
          : '첨부된 상대 의견을 읽고 후속 발언을 해줘.', context_from: refs } }] });
    // Replay the real Gemini opening: create a scope, then accidentally omit the worker selection.
    const missingSelection = JSON.stringify({ message: '', finish: false, calls: [
      { tool: 'shared_context', input: { operation: 'open', title: 'JavaScript vs Python Debate' } },
      { tool: 'agent', input: { agent: ['claude', 'codex'], kind: 'answer',
        prompt: "Debate whether JavaScript or Python is 'better' for general-purpose programming. This is turn 1 of 3. Please provide your opening argument." } },
    ] });
    const reply = source === 'replay' ? replayMissingSelection ? missingSelection
      : replayCall(calls.length === 0 ? [] : calls.length === 1 ? ['task:1', 'task:2'] : ['task:3', 'task:4'])
      : await model.chat(messages, options);
    let injectedReply: string | undefined;
    if (source === 'replay' && calls.length === 2) {
      injectedReply = replayCall(['task:1195', 'task:1618']);
      injected = true;
    }
    calls.push({ source, reply, ...(injectedReply ? { injectedReply } : {}),
      toolResults: messages.filter((message) => message.content.startsWith('TOOL RESULT')).map((message) => message.content) });
    console.log(`${label}: ${source} step ${calls.length}, workers ${agents.claude.prompts.length}/${agents.codex.prompts.length}${injectedReply ? ', injected invalid refs' : ''}`);
    return injectedReply ?? reply;
  } };
  const h = harness({ agents, llm, cwd });
  const aside = new Transcript();
  model = provider === 'acp'
    ? new AcpModel({ agentId: config.orchestration.acp.agent, profile: config.agents[config.orchestration.acp.agent]!, model: modelName,
      host: { agentId: 'orchestrator', config, workspace: h.runtime.workspace, jail: h.runtime.jail, policy: h.runtime.policy, transcript: aside } })
    : new LocalModel({ ...config.orchestration.local, model: modelName! });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; h.runtime.conversation.cancel(); }, 180_000);
  try {
    const prompt = checkShared
      ? 'js와 python 중에 어느 언어가 더 좋은지 @claude @codex 토론해. 각자 세 번 발언해. 처음에는 독립적으로 입장을 밝히고, 두 번째부터는 양쪽의 이전 발언을 모두 포함한 대화 전체를 읽고 의견을 제시해.'
      : 'js vs python 어느게 좋은지 @claude , @codex 토론해. 단 발언권 각 3회씩.';
    await h.runtime.conversation.send(prompt);
    const counts = Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, agent.prompts.length]));
    const records = h.runtime.transcript.all();
    const errors = calls.flatMap((call) => call.toolResults).filter((text) => text.includes('invalid_task_reference'));
    const missingSelectionErrors = calls.flatMap((call) => call.toolResults).filter((text) => text.includes('shared_context_required'));
    const finished = records.some((record) => record.type === 'context' && record.entry.event === 'finish' && record.entry.status === 'reported');
    const sharedDelivery = Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, agent.prompts.map((brief, index) => ({
      snapshot: brief.includes('SHARED CONVERSATION ('), originalRequest: brief.includes(prompt),
      independentOpening: index !== 0 || !brief.includes(id === 'claude' ? 'CODEX_REPLY_1:' : 'CLAUDE_REPLY_1:'),
      priorReplies: Array.from({ length: index }, (_,round) => ['CLAUDE', 'CODEX'].every((author) => brief.includes(`${author}_REPLY_${round + 1}:`))),
    }))]));
    const delivered = !checkShared || Object.values(sharedDelivery).every((checks) => checks.every((check) => check.snapshot && check.originalRequest
      && check.independentOpening && check.priorReplies.every(Boolean)));
    const passed = delivered && finished && !timedOut && Object.values(counts).every((count) => count === 3)
      && (!injectFault || (injected && errors.length > 0)) && (!replayMissingSelection || missingSelectionErrors.length > 0);
    evidence.scenarios.push({ label, passed, timedOut, injected, counts, ...(checkShared ? { sharedDelivery } : {}), calls,
      workerPrompts: Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, agent.prompts])),
      final: records.filter((record) => record.type === 'assistant' && !record.ledger).at(-1),
      records, plannerRecords: aside.all() });
    console.log(`${label}: ${passed ? 'PASS' : 'FAIL'} (${JSON.stringify(counts)})`);
    if (!calls.some((call) => call.source === 'model')) throw new Error('The planner returned no reply. Inspect plannerRecords in the evidence file for authentication or connection errors.');
    return passed;
  } finally {
    clearTimeout(timeout);
    fs.writeFileSync(reportFile, JSON.stringify(evidence, null, 2));
    await model.close?.();
    await h.dispose();
    await aside.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

try {
  const baseline = (!checkShared && process.argv.includes('--recovery-only')) || await scenario(false);
  const recovery = checkShared || await scenario(true);
  evidence.passed = baseline && recovery;
  if (!evidence.passed) process.exitCode = 1;
} finally {
  fs.writeFileSync(reportFile, JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${reportFile}`);
}
