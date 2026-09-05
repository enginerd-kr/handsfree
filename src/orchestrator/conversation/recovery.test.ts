import { describe, expect, it } from 'vitest';
import type { ChatClient, ChatMessage } from '../../models/client.js';
import { ModelError } from '../../models/completion.js';
import { nextStep } from './plan.js';
import { Toolbox } from './tools/tool.js';
import { recoverWindow } from './window.js';

const answer = JSON.stringify({ message: 'Done.', calls: [], finish: true });
const signal = new AbortController().signal;

describe('model recovery', () => {
  it('stops malformed JSON recovery without limiting valid work steps', async () => {
    let calls = 0;
    const llm: ChatClient = { async chat() { calls++; return 'not JSON'; } };
    await expect(nextStep(llm, [], new Toolbox([]), signal)).rejects.toMatchObject({ kind: 'format' });
    expect(calls).toBe(3);
  });

  it('does not accept even valid JSON from a truncated response', async () => {
    const seen: ChatMessage[][] = [];
    const llm: ChatClient = { async chat(messages, options) {
      seen.push(messages);
      options?.onFinish?.(seen.length === 1 ? 'truncated' : 'complete');
      return answer;
    } };
    expect((await nextStep(llm, [], new Toolbox([]), signal)).ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.at(-1)?.content).toContain('shorter complete JSON');
  });

  it('stops repeated truncation and immediately reports authentication or refusal', async () => {
    for (const kind of ['truncated', 'authentication', 'refused'] as const) {
      let calls = 0;
      const llm: ChatClient = { async chat() { calls++; throw new ModelError(kind, kind); } };
      await expect(nextStep(llm, [], new Toolbox([]), signal)).rejects.toMatchObject({ kind });
      expect(calls).toBe(kind === 'truncated' ? 2 : 1);
    }
  });

  it('recovers context once and stops if the reduced window still cannot fit', async () => {
    let calls = 0, recovered = 0;
    const llm: ChatClient = { async chat() { calls++; throw { status: 400, code: 'context_length_exceeded', message: 'context limit' }; } };
    await expect(nextStep(llm, [], new Toolbox([]), signal, undefined, () => {
      recovered++; return [{ role: 'user', content: 'required' }];
    })).rejects.toMatchObject({ kind: 'context' });
    expect(calls).toBe(2);
    expect(recovered).toBe(1);
  });

  it('retains user constraints, paired latest replies and a source checkpoint', () => {
    const old = 'old evidence '.repeat(1000);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Never edit the schema.' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', pinned: true, content: `${old} Current request`, requiredContent: 'Current request' },
      { role: 'assistant', content: 'call A1' },
      { role: 'user', content: `TOOL RESULT ${old}`, agents: ['a'] },
      { role: 'assistant', content: 'call B' },
      { role: 'user', content: 'TOOL RESULT latest B rebuttal', agents: ['b'] },
      { role: 'assistant', content: 'call A2' },
      { role: 'user', content: 'TOOL RESULT latest A rebuttal', agents: ['a'] },
      { role: 'user', pinned: true, content: 'USER UPDATE: now summarize' },
    ];
    const recovered = recoverWindow(messages, 99)!;
    const text = recovered.map((message) => message.content).join('\n');
    expect(text).not.toContain(old);
    for (const retained of ['Never edit the schema', 'record 99', 'Current request', 'call B', 'latest B rebuttal', 'call A2', 'latest A rebuttal', 'now summarize']) expect(text).toContain(retained);
    expect(messages[3]?.content).toContain(old);
  });
});
