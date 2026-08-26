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
  it('plans and answers through an agent instead of a local endpoint', async () => {
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
      orchestration: { provider: 'acp', acp: { agent: 'claude', timeoutMs: 5_000 } },
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
});
