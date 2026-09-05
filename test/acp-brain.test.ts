import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { createRuntime } from '../src/runtime.js';
import { fakeAgent } from './fake-agent.js';

/**
 * The orchestration model running as an ACP agent rather than a local endpoint.
 * The same fake agent machinery stands in for the frontier model, scripted to
 * answer the way a planner should.
 */
describe('acp orchestration', () => {
  it('accepts an ACP reply exceeding the requested output size without cancelling', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-acp-brain-'));
    const brain = fakeAgent({
      script: () => [
        {
          do: 'say',
          text: JSON.stringify({ action: 'answer', message: 'Hello from the frontier.' }),
        },
      ],
    });
    const config = ConfigSchema.parse({
      workspaceRoot: root,
      orchestration: { provider: 'acp', maxOutputTokens: 1, acp: { agent: 'claude', timeoutMs: 5_000 } },
      agents: { claude: { command: 'unused', args: [] } },
      limits: { turnTimeoutMs: 5_000, idleTimeoutMs: 5_000, cancelGraceMs: 500 },
    });
    const runtime = createRuntime({ config, createTarget: () => brain.target() });

    try {
      await runtime.conversation.send('hello');

      const assistant = runtime.transcript
        .all()
        .filter((record) => record.type === 'assistant')
        .map((record) => record.text);
      expect(assistant).toContain('Hello from the frontier.');

      // The whole conversation travels in the prompt, format instructions last.
      expect(brain.prompts[0]).toContain('[system]');
      expect(brain.prompts[0]).toContain('hello');
      expect(brain.prompts[0]).toContain('JSON Schema');

      // Planning chatter never renders as agent output in the user's transcript.
      expect(runtime.transcript.all().some((record) => record.type === 'session_update')).toBe(
        false,
      );
    } finally {
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the planning turn down at the count the agent gave', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-acp-brain-'));
    const brain = fakeAgent({
      script: () => [
        { do: 'say', text: JSON.stringify({ action: 'answer', message: 'Counted.' }) },
        {
          do: 'stop',
          reason: 'end_turn',
          // Claude's shape: what was read from cache is counted apart.
          usage: { inputTokens: 500, outputTokens: 40, cachedReadTokens: 2_000, totalTokens: 2_540 },
        },
      ],
    });
    const config = ConfigSchema.parse({
      workspaceRoot: root,
      orchestration: { provider: 'acp', acp: { agent: 'claude', timeoutMs: 5_000 } },
      agents: { claude: { command: 'unused', args: [] } },
      limits: { turnTimeoutMs: 5_000, idleTimeoutMs: 5_000, cancelGraceMs: 500 },
    });
    const runtime = createRuntime({ config, createTarget: () => brain.target() });

    try {
      await runtime.conversation.send('hello');

      const usage = runtime.transcript.all().find((record) => record.type === 'usage');
      // The cached read was still read, so it sits on the prompt side.
      expect(usage).toMatchObject({ purpose: 'plan', promptTokens: 2_500, completionTokens: 40 });
    } finally {
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('opens a fresh session for every reply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-acp-brain-'));
    const brain = fakeAgent({
      script: (_prompt, turn) => [
        {
          do: 'say',
          text: JSON.stringify({ action: 'answer', message: `reply ${turn}` }),
        },
      ],
    });
    const config = ConfigSchema.parse({
      workspaceRoot: root,
      orchestration: { provider: 'acp', acp: { agent: 'claude', timeoutMs: 5_000 } },
      agents: { claude: { command: 'unused', args: [] } },
      limits: { turnTimeoutMs: 5_000, idleTimeoutMs: 5_000, cancelGraceMs: 500 },
    });
    const runtime = createRuntime({ config, createTarget: () => brain.target() });

    try {
      await runtime.conversation.send('one');
      await runtime.conversation.send('two');

      expect(brain.prompts).toHaveLength(2);
      // The second prompt re-renders the conversation so far, first turn included.
      expect(brain.prompts[1]).toContain('one');
      expect(brain.prompts[1]).toContain('two');
    } finally {
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('plans on the model the config names, every session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-acp-brain-'));
    const brain = fakeAgent({
      models: ['sonnet', 'opus[1m]', 'haiku'],
      script: () => [{ do: 'say', text: JSON.stringify({ action: 'answer', message: 'planned' }) }],
    });
    const config = ConfigSchema.parse({
      workspaceRoot: root,
      // Matched the way a person types it, so a prefix is enough.
      orchestration: { provider: 'acp', acp: { agent: 'claude', model: 'haik', timeoutMs: 5_000 } },
      agents: { claude: { command: 'unused', args: [] } },
      limits: { turnTimeoutMs: 5_000, idleTimeoutMs: 5_000, cancelGraceMs: 500 },
    });
    const runtime = createRuntime({ config, createTarget: () => brain.target() });

    try {
      await runtime.conversation.send('one');
      await runtime.conversation.send('two');
      // Set on the session that needed it and not again: the second session
      // came up on it already, and a switch to the model you are on is a round
      // trip that says nothing.
      expect(brain.modelSets).toEqual(['haiku']);
      expect(brain.prompts).toHaveLength(2);
    } finally {
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the turn, naming the roster, when the model is not on it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-acp-brain-'));
    const brain = fakeAgent({
      models: ['sonnet', 'opus[1m]'],
      script: () => [{ do: 'say', text: JSON.stringify({ action: 'answer', message: 'planned' }) }],
    });
    const config = ConfigSchema.parse({
      workspaceRoot: root,
      orchestration: { provider: 'acp', acp: { agent: 'claude', model: 'gpt-5', timeoutMs: 5_000 } },
      agents: { claude: { command: 'unused', args: [] } },
      limits: { turnTimeoutMs: 5_000, idleTimeoutMs: 5_000, cancelGraceMs: 500 },
    });
    const runtime = createRuntime({ config, createTarget: () => brain.target() });

    try {
      await runtime.conversation.send('hello');
      const said = runtime.transcript
        .all()
        .filter((record) => record.type === 'assistant')
        .map((record) => record.text)
        .join('\n');
      // The roster is the answer someone who typed a name blind needs.
      expect(said).toContain('no model matching "gpt-5"');
      expect(said).toContain('sonnet, opus[1m]');
      // And nothing was planned on the wrong model in the meantime.
      expect(brain.prompts).toHaveLength(0);
    } finally {
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * `@orchestrator:agent:model` — the planner moved while the conversation it
   * is planning stays where it is.
   */
  describe('moved by a mention', () => {
    const two = (root: string) => {
      const claude = fakeAgent({
        script: () => [{ do: 'say', text: JSON.stringify({ action: 'answer', message: 'claude planned' }) }],
      });
      const gemini = fakeAgent({
        models: ['gemini-3.5-flash', 'gemini-3.5-pro'],
        script: () => [{ do: 'say', text: JSON.stringify({ action: 'answer', message: 'gemini planned' }) }],
      });
      const config = ConfigSchema.parse({
        workspaceRoot: root,
        orchestration: { provider: 'acp', acp: { agent: 'claude', timeoutMs: 5_000 } },
        agents: { claude: { command: 'unused', args: [] }, gemini: { command: 'unused', args: [] } },
        limits: { turnTimeoutMs: 5_000, idleTimeoutMs: 5_000, cancelGraceMs: 500 },
      });
      const runtime = createRuntime({
        config,
        createTarget: (agentId) => (agentId === 'gemini' ? gemini.target() : claude.target()),
      });
      return { claude, gemini, config, runtime };
    };

    const notes = (runtime: ReturnType<typeof createRuntime>) =>
      runtime.transcript
        .all()
        .filter((record) => record.type === 'note')
        .map((record) => record.text);

    it('plans through the agent and model the address names, from then on', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-acp-brain-'));
      const { claude, gemini, config, runtime } = two(root);

      try {
        await runtime.conversation.send('hello');
        await runtime.conversation.send('@orchestrator:gemini:pro');
        await runtime.conversation.send('hello again');

        expect(claude.prompts).toHaveLength(1);
        expect(gemini.prompts).toHaveLength(1);
        // The name was typed short; the planner's own session matched it.
        expect(gemini.modelSets).toEqual(['gemini-3.5-pro']);
        // Said once, where it can be seen, and written into the config so that
        // /agents and doctor describe what is actually planning.
        expect(notes(runtime)).toContain('orchestration: gemini over acp on pro');
        expect(config.orchestration.acp.agent).toBe('gemini');
        expect(config.orchestration.acp.model).toBe('pro');
      } finally {
        await runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('takes the rest of the line as the first thing the new planner is asked', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-acp-brain-'));
      const { claude, gemini, runtime } = two(root);

      try {
        await runtime.conversation.send('@orchestrator:gemini 이거 해줘');

        expect(claude.prompts).toHaveLength(0);
        expect(gemini.prompts).toHaveLength(1);
        expect(gemini.prompts[0]).toContain('이거 해줘');
        // The address moved the planner; it is not part of what was asked.
        expect(gemini.prompts[0]).not.toContain('@orchestrator');
      } finally {
        await runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses an agent nobody configured, and stays where it was', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-acp-brain-'));
      const { claude, gemini, config, runtime } = two(root);

      try {
        await runtime.conversation.send('@orchestrator:nope:opus do it');

        expect(notes(runtime)).toContain('No agent named "nope" is configured.');
        // Neither the work nor the planner moved: the line asked for a planner
        // that does not exist, and running it on the old one is not that.
        expect(claude.prompts).toHaveLength(0);
        expect(gemini.prompts).toHaveLength(0);
        expect(config.orchestration.acp.agent).toBe('claude');

        await runtime.conversation.send('hello');
        expect(claude.prompts).toHaveLength(1);
      } finally {
        await runtime.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
