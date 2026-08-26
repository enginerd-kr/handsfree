import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../config/schema.js';
import type { ChatClient, ChatMessage, ChatOptions } from '../llm/client.js';
import { Orchestrator } from './orchestrator.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-orch-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * A stand-in for the `claude` CLI. It ignores its argv, writes noise to stderr and
 * a `--output-format json` payload to stdout — which is exactly the shape that used
 * to break parsing when both channels were merged before `JSON.parse`.
 */
function stubClaudeCli(name: string, body: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Replies with a canned script of model outputs, then repeats the last one. */
function scriptedLlm(replies: string[]): ChatClient & { calls: ChatMessage[][] } {
  let i = 0;
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async chat(messages: ChatMessage[], _opts?: ChatOptions): Promise<string> {
      calls.push(messages);
      const reply = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return reply;
    },
  };
}

function makeConfig(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    workspaceRoot: path.join(tmp, 'ws'),
    orchestrator: { maxTurns: 1, maxDelegationsPerMessage: 1 },
    ...over,
  });
}

/** Collects the user-visible event stream of one turn. */
async function runTurn(config: Config, llm: ChatClient, message: string) {
  const orchestrator = new Orchestrator(config, undefined, { llm });
  const assistant: string[] = [];
  const finished: string[] = [];
  let doneCount = 0;
  orchestrator.on('assistant_text', (t) => assistant.push(t));
  orchestrator.on('task_finished', ({ status }) => finished.push(status));
  orchestrator.on('turn_done', () => (doneCount += 1));
  await orchestrator.handleUserMessage(message);
  return { assistant, finished, doneCount, orchestrator };
}

const DELEGATE = JSON.stringify({
  action: 'delegate',
  agent: 'claude',
  task: 'Create notes.txt containing hello world',
  done_when: 'notes.txt exists',
});

describe('a turn that delegated always reports back', () => {
  it('summarises even when the model never emits a respond action', async () => {
    const cli = stubClaudeCli(
      'ok-cli',
      `process.stderr.write('warning: update available\\n');
       process.stdout.write(JSON.stringify({ result: 'Created notes.txt', is_error: false }));`,
    );
    const config = makeConfig({ agents: { claude: { command: cli } } });
    // The model only ever delegates — the old loop fell out of maxTurns silently.
    const { assistant, finished, doneCount } = await runTurn(config, scriptedLlm([DELEGATE]), 'make notes.txt');

    expect(finished).toEqual(['success']);
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatch(/1 task ran/);
    expect(assistant[0]).toMatch(/succeeded/);
    expect(doneCount).toBe(1);
  });

  it('falls back to the ledger when the summarising model returns an action instead of prose', async () => {
    const cli = stubClaudeCli(
      'ok-cli-2',
      `process.stdout.write(JSON.stringify({ result: 'Created notes.txt', is_error: false }));`,
    );
    const config = makeConfig({ agents: { claude: { command: cli } } });
    const { assistant } = await runTurn(config, scriptedLlm([DELEGATE]), 'make notes.txt');
    // The stub answers the summary request with JSON too; the ledger must win.
    expect(assistant[0]).not.toMatch(/^\{/);
    expect(assistant[0]).toMatch(/full result: tasks\/1-claude\/result\.md/);
  });

  it('still reports when the summarising model call fails outright', async () => {
    const cli = stubClaudeCli(
      'ok-cli-3',
      `process.stdout.write(JSON.stringify({ result: 'Created notes.txt', is_error: false }));`,
    );
    const config = makeConfig({ agents: { claude: { command: cli } } });
    let call = 0;
    const llm: ChatClient = {
      async chat() {
        call += 1;
        if (call === 1) return DELEGATE;
        throw new Error('connection refused');
      },
    };
    const { assistant, finished } = await runTurn(config, llm, 'make notes.txt');
    expect(finished).toEqual(['success']);
    expect(assistant[0]).toMatch(/1 task ran/);
  });

  it('reports the failure when the CLI itself fails', async () => {
    const cli = stubClaudeCli(
      'bad-cli',
      `process.stderr.write('Error: not logged in\\n'); process.exit(1);`,
    );
    const config = makeConfig({ agents: { claude: { command: cli } } });
    const { assistant, finished } = await runTurn(config, scriptedLlm([DELEGATE]), 'make notes.txt');

    expect(finished).toEqual(['error']);
    expect(assistant[0]).toMatch(/0 succeeded, 1 did not/);
    expect(assistant[0]).toMatch(/failed/);
  });

  it('uses the model’s prose when it actually writes prose', async () => {
    const cli = stubClaudeCli(
      'ok-cli-4',
      `process.stdout.write(JSON.stringify({ result: 'Created notes.txt', is_error: false }));`,
    );
    const config = makeConfig({ agents: { claude: { command: cli } } });
    const llm = scriptedLlm([DELEGATE, 'I had claude create notes.txt with "hello world".']);
    const { assistant } = await runTurn(config, llm, 'make notes.txt');
    expect(assistant[0]).toBe('I had claude create notes.txt with "hello world".');
  });
});

describe('turns that delegated nothing', () => {
  it('passes a respond action straight through, with no ledger', async () => {
    const reply = JSON.stringify({ action: 'respond', message: 'Hi there.' });
    const { assistant, finished } = await runTurn(makeConfig(), scriptedLlm([reply]), 'hi');
    expect(assistant).toEqual(['Hi there.']);
    expect(finished).toEqual([]);
  });

  it('says something when the model never produces a valid action', async () => {
    const { assistant, doneCount } = await runTurn(makeConfig(), scriptedLlm(['not json']), 'hi');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatch(/did not produce a valid next step/);
    expect(doneCount).toBe(1);
  });

  it('reports a disabled agent instead of going quiet', async () => {
    const config = makeConfig({ agents: { claude: { enabled: false } } });
    const { assistant, finished } = await runTurn(config, scriptedLlm([DELEGATE]), 'make notes.txt');
    expect(finished).toEqual([]);
    expect(assistant[0]).toMatch(/disabled/);
  });
});

describe('conversation history', () => {
  it('trims to the configured window while keeping the system prompt', async () => {
    const config = makeConfig({ orchestrator: { maxTurns: 1, maxHistoryMessages: 4 } });
    const reply = JSON.stringify({ action: 'respond', message: 'ok' });
    const orchestrator = new Orchestrator(config, undefined, { llm: scriptedLlm([reply]) });
    for (let i = 0; i < 10; i++) await orchestrator.handleUserMessage(`message ${i}`);

    const messages = (orchestrator as unknown as { messages: ChatMessage[] }).messages;
    expect(messages).toHaveLength(5);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/You are handsfree/);
    expect(messages.at(-1)?.content).toContain('ok');
  });
});
