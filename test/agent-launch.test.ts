import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { createRuntime } from '../src/runtime.js';
import { openAgent } from '../src/host/open.js';
import { fakeAgent } from './fake-agent.js';
import { harness } from './harness.js';

describe('agent launch retries', () => {
  it.each(['worker', 'planner'])('retries renamed flags and reuses the %s connection', async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-launch-'));
    const agent = fakeAgent({ script: () => [
      { do: 'say', text: JSON.stringify({ action: 'answer', message: 'Ready.' }) },
    ] });
    const config = ConfigSchema.parse({ workspaceRoot: root,
      orchestration: { provider: 'acp', acp: { agent: 'gemini' } },
      agents: { gemini: { command: 'unused', args: ['--acp'] } },
    });
    const failedClose = vi.fn(async () => {});
    const launches: { id: string; args: string[] }[] = [];
    const runtime = createRuntime({ config, createTarget: (id, profile) => {
      launches.push({ id, args: profile.args });
      if (profile.args.includes('--acp')) return {
        description: 'unsupported flag',
        connect() { throw new Error('Unsupported --acp'); },
        close: failedClose,
      };
      return agent.target();
    } });
    try {
      for (let turn = 0; turn < 2; turn++) {
        if (kind === 'worker') {
          const session = await runtime.pool.session('gemini');
          await session.prompt('hello', {});
        } else {
          await runtime.conversation.send('hello');
        }
      }
      expect(agent.prompts).toHaveLength(2);
      expect(launches).toEqual([
        { id: 'gemini', args: ['--acp'] },
        { id: 'gemini', args: ['--experimental-acp'] },
      ]);
      expect(failedClose).toHaveBeenCalledOnce();
      expect(config.agents.gemini?.args).toEqual(['--acp']);
    } finally {
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not launch a fallback after cancellation during cleanup', async () => {
    const h = harness({ agents: { gemini: fakeAgent({ script: () => [] }) } });
    const controller = new AbortController();
    const createTarget = vi.fn(() => ({
      description: 'failed launch',
      connect() { throw new Error('Unsupported flag'); },
      async close() { controller.abort(new Error('Cancelled launch')); },
    }));
    try {
      await expect(openAgent({ agentId: 'gemini',
        profile: { ...h.runtime.config.agents.gemini!, args: ['--acp'] },
        host: { ...h.runtime, agentId: 'orchestrator' },
        signal: controller.signal, createTarget,
      })).rejects.toThrow('Cancelled launch');
      expect(createTarget).toHaveBeenCalledOnce();
    } finally {
      await h.dispose();
    }
  });
});
