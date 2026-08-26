import fs from 'node:fs';
import type { Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';
import type { AgentAdapter, AgentOutput, Invocation, ParsedOutput } from './types.js';
import { findDenialPhrases } from './denials.js';

interface CodexEvent {
  msg?: { type?: string; message?: string };
}

export const codexAdapter: AgentAdapter = {
  name: 'codex',

  buildInvocation(prompt: string, task: TaskPaths, runDir: string, config: Config): Invocation {
    const cfg = config.agents.codex;
    return {
      command: cfg.command,
      args: [
        'exec',
        '--json',
        '-C',
        runDir,
        '-s',
        cfg.sandbox,
        '--skip-git-repo-check',
        '-o',
        task.lastMessageFile,
        ...(cfg.model ? ['-m', cfg.model] : []),
        ...cfg.extraArgs,
        prompt,
      ],
    };
  },

  parseOutput({ stdout, stderr }: AgentOutput, task: TaskPaths): ParsedOutput {
    let fromFile = '';
    try {
      fromFile = fs.readFileSync(task.lastMessageFile, 'utf8').trim();
    } catch {
      // Fall back to scanning JSONL events for the last agent message.
    }

    let lastAgentMessage = '';
    let isError = false;
    const denials: string[] = [];
    for (const line of stdout.split('\n')) {
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        continue; // Non-JSON lines are fine.
      }
      const msg = event.msg;
      if (!msg?.type) continue;
      if (msg.type === 'agent_message' && msg.message) lastAgentMessage = msg.message;
      if (msg.type === 'error') {
        isError = true;
        // An error event that names a denial is structural evidence, unlike a
        // phrase the agent merely narrated in its answer.
        if (findDenialPhrases(msg.message ?? '').length > 0) {
          denials.push((msg.message ?? '').slice(0, 200));
        }
      }
    }

    const finalMessage = fromFile || lastAgentMessage || stdout.trim() || stderr.trim();
    return {
      finalMessage,
      isError,
      denials,
      // Scan the answer only. The raw JSONL carries tool logs and reasoning where
      // denial-shaped phrases appear constantly without meaning the task failed.
      denialHints: findDenialPhrases(finalMessage),
    };
  },
};
