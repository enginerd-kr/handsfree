import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema } from '../src/config/schema.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import type { ChatClient, ChatMessage } from '../src/brain/client.js';
import type { FakeAgent } from '../test/fake-agent.js';

/**
 * The run id every screenshot is taken under. Fixed, so a re-shot README
 * differs where the UI changed and nowhere else.
 */
const RUN_ID = '2026-08-28T09-12-10-12658';

/**
 * A home directory of our own, so the header's path reads the way it reads on
 * a real machine — `~/.handsfree/runs/…` — instead of naming a temp directory.
 * `HOME` is what `os.homedir()` answers with on POSIX, and the root is
 * resolved first because the workspace resolves its own path and a `/var`
 * that is really `/private/var` would no longer sit under the home we set.
 */
function stageHome(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-e2e-')));
  process.env.HOME = home;
  return home;
}

export interface StageOptions {
  agents: Record<string, FakeAgent>;
  /** Per-agent profile fields beyond the launch line — the optional model pin. */
  profiles?: Record<string, { model?: string; note?: string }>;
  /** Which model plans, for what the header and the roll call say about it. */
  orchestration?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  llm?: ChatClient;
}

export interface Stage {
  runtime: Runtime;
  dispose(): Promise<void>;
}

/** A runtime dressed for a screenshot: real code, scripted agents, tidy paths. */
export function stage(options: StageOptions): Stage {
  const home = stageHome();
  const root = path.join(home, '.handsfree');
  const config = ConfigSchema.parse({
    workspaceRoot: root,
    agents: Object.fromEntries(
      Object.keys(options.agents).map((id) => [
        id,
        { command: 'unused', args: [], ...(options.profiles?.[id] ?? {}) },
      ]),
    ),
    capabilities: { terminal: true },
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
    policy: options.policy ?? {},
    limits: { turnTimeoutMs: 10_000, idleTimeoutMs: 10_000, cancelGraceMs: 500 },
  });
  config.workspaceRoot = root;

  const runtime = createRuntime({
    config,
    runId: RUN_ID,
    llm: options.llm,
    createTarget: (agentId) => {
      const agent = options.agents[agentId];
      if (!agent) throw new Error(`no scripted agent registered for ${agentId}`);
      return agent.target();
    },
  });

  return {
    runtime,
    async dispose() {
      await runtime.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * A planner that reads from a fixed list of replies. Running dry throws rather
 * than quietly answering, so a shot can never be taken of a turn nobody wrote.
 */
export function scripted(replies: string[]): ChatClient {
  let index = 0;
  return {
    async chat(_messages: ChatMessage[]) {
      const reply = replies[index++];
      if (reply === undefined) throw new Error('the scripted planner has no reply left');
      return reply;
    },
  };
}

/** A planner reply that hands one task to one agent. */
export const delegate = (agent: string, task: string, kind: 'answer' | 'change' = 'change'): string =>
  JSON.stringify({ action: 'call', tool: 'agent', input: { agent, kind, prompt: task } });

/** A planner reply that closes the turn with a written answer. */
export const answer = (message: string): string => JSON.stringify({ action: 'answer', message });
