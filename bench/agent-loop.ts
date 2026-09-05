import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { LocalModel, type ChatClient } from '../src/models/client.js';
import { fakeAgent } from '../test/fake-agent.js';
import { harness } from '../test/harness.js';

// Explicit live planner check; workers are deterministic fixtures, never real CLIs.
const config = loadConfig().config;
const modelOverride = process.argv.find((arg) => arg.startsWith('--model='))?.slice(8);
const model = new LocalModel({ ...config.orchestration.local, ...(modelOverride ? { model: modelOverride } : {}) });
const agents = {
  claude: fakeAgent({ script: () => [{ do: 'say', text: '기존 --legacy 옵션 동작을 유지해야 합니다.\n\nREPORT\noutcome: done\nsummary: --legacy 호환성 유지가 필요함.\nverify: 문서 검토' }] }),
  gemini: fakeAgent({ script: () => [{ do: 'say', text: '검증 항목: --legacy 옵션이 기존과 같은 값을 반환하는지 확인합니다.\n\nREPORT\noutcome: done\nsummary: --legacy 회귀 검증 항목 제안.\nverify: 기존 값과 결과 비교' }] }),
};
const evidence = { model: modelOverride ?? config.orchestration.local.model,
  calls: [] as { inputChars: number; reply: string }[], turns: [] as unknown[], passed: false };
const reportFile = path.join(os.tmpdir(), `handsfree-loop-check-${Date.now()}.json`);
const llm: ChatClient = { async chat(messages, options) {
  const reply = await model.chat(messages, options);
  evidence.calls.push({ inputChars: messages.reduce((n, m) => n + m.content.length, 0), reply });
  return reply;
} };
let h = harness({ agents, llm });
try {
  for (const prompt of [
    '한국어로 답해. --legacy 옵션 동작을 유지해야 해. 먼저 claude에게 호환성 검토 의견을 묻고, 그 결과를 바탕으로 gemini에게 검증 항목을 물어봐. 마지막에 네가 종합해 줘.',
    '이전 제약이 뭐였지? 기존 결과로만 답해.',
  ]) {
    await h.runtime.conversation.send(prompt);
    const records = h.runtime.transcript.all();
    const reply = records.filter((r) => r.type === 'assistant').findLast((r) => r.text !== '');
    const counts = Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, agent.prompts.length]));
    evidence.turns.push({ prompt, reply, counts, context: records.filter((r) => r.type === 'context') });
    fs.writeFileSync(reportFile, JSON.stringify(evidence, null, 2));
    if (Object.values(counts).some((count) => count !== 1)) throw new Error('Expected one call to each worker, with no repeated delegation.');
    if (!reply || !reply.text.includes('--legacy')) throw new Error('The report did not retain the central constraint.');
    if (evidence.turns.length === 1) {
      const resume = { root: h.root, runId: h.runtime.workspace.id };
      await h.runtime.close();
      h = harness({ agents, llm, resume });
    }
  }
  evidence.passed = true;
} finally {
  fs.writeFileSync(reportFile, JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${reportFile}`);
  await h.dispose();
}
