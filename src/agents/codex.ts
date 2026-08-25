import fs from 'node:fs';
import type { Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';
import type { AgentAdapter, Invocation, ParsedOutput } from './types.js';
import { findDenialPhrases } from './denials.js';

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

  parseOutput(raw: string, task: TaskPaths): ParsedOutput {
    let finalMessage = '';
    try {
      finalMessage = fs.readFileSync(task.lastMessageFile, 'utf8').trim();
    } catch {
      // Fall back to scanning JSONL events for the last agent message.
    }
    if (!finalMessage) {
      for (const line of raw.split('\n')) {
        try {
          const event = JSON.parse(line) as { msg?: { type?: string; message?: string } };
          if (event.msg?.type === 'agent_message' && event.msg.message) {
            finalMessage = event.msg.message;
          }
        } catch {
          // Non-JSON lines are fine.
        }
      }
    }
    if (!finalMessage) finalMessage = raw;
    const denials = findDenialPhrases(raw);
    return { finalMessage, isError: false, denials };
  },
};
