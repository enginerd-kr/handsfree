import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema, type Config } from '../src/config/schema.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import type { ChatClient, ChatMessage } from '../src/models/client.js';
import type { Escalator } from '../src/policy/types.js';
import type { FakeAgent } from './fake-agent.js';

export interface HarnessOptions {
  agents: Record<string, FakeAgent>;
  config?: Partial<{
    capabilities: Partial<Config['capabilities']>;
    /** Per-agent profile fields beyond the command — the optional model override. */
    profiles: Record<string, { model?: string; nativeTools?: 'allow' | 'deny' }>;
    /** What each agent is for, as a config file would say it. */
    roles: Record<string, string>;
    /** Which model plans, for what the status line and `/agents` say about it. */
    orchestration: Record<string, unknown>;
    execution: Record<string, unknown>;
    prices: Config['prices'];
  }>;
  llm?: ChatClient;
  /** The human seat. Without one every `ask` is a denial, as it is headless. */
  escalator?: Escalator;
  /** Where command files are looked for. Defaults to the process's own cwd. */
  cwd?: string;
  /**
   * A root and run to come back to, for a test about resuming: the second
   * harness on the same pair finds the first one's record and sessions.
   */
  resume?: { root: string; runId: string };
}

export interface Harness {
  runtime: Runtime;
  workspaceDir: string;
  /** The workspace root, so a second harness can resume this one's run. */
  root: string;
  dispose(): Promise<void>;
}

export function harness(options: HarnessOptions): Harness {
  const root = options.resume?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-test-'));
  const config = ConfigSchema.parse({
    workspaceRoot: root,
    agents: Object.fromEntries(
      Object.keys(options.agents).map((id) => [
        id,
        { command: 'unused', args: [], ...(options.config?.profiles?.[id] ?? {}) },
      ]),
    ),
    ...(options.config?.roles ? { roles: options.config.roles } : {}),
    capabilities: { terminal: true, ...(options.config?.capabilities ?? {}) },
    ...(options.config?.orchestration ? { orchestration: options.config.orchestration } : {}),
    ...(options.config?.execution ? { execution: options.config.execution } : {}),
    ...(options.config?.prices ? { prices: options.config.prices } : {}),
  });
  config.workspaceRoot = root;

  const runtime = createRuntime({
    config,
    llm: options.llm,
    ...(options.escalator === undefined ? {} : { escalator: options.escalator }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.resume === undefined ? {} : { runId: options.resume.runId }),
    createTarget: (agentId) => {
      const agent = options.agents[agentId];
      if (!agent) throw new Error(`no fake agent registered for ${agentId}`);
      return agent.target();
    },
  });

  return {
    runtime,
    workspaceDir: runtime.workspace.dir,
    root,
    async dispose() {
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A local model that reads from a fixed list of replies and fails once they run
 * out. Running dry is treated as an endpoint failure rather than an implicit
 * "done", so a test can never pass because of a reply it did not write.
 */
export function scriptedModel(replies: string[]): ChatClient & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let index = 0;
  return {
    seen,
    async chat(messages) {
      // A copy: the conversation goes on mutating its history after the call,
      // and a test asserting on what the planner was *sent* has to see the
      // messages as they were sent.
      seen.push([...messages]);
      const reply = replies[index++];
      if (reply === undefined) throw new Error('scripted model has no reply left');
      return reply;
    },
  };
}
