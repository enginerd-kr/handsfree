import type { Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';
import type { AgentAdapter, Invocation, ParsedOutput } from './types.js';
import { findDenialPhrases } from './denials.js';

export const geminiAdapter: AgentAdapter = {
  name: 'gemini',

  buildInvocation(prompt: string, _task: TaskPaths, runDir: string, config: Config): Invocation {
    const cfg = config.agents.gemini;
    return {
      command: cfg.command,
      args: [
        '-o',
        'json',
        '--approval-mode',
        cfg.approvalMode,
        '--include-directories',
        runDir,
        ...(cfg.model ? ['-m', cfg.model] : []),
        ...cfg.extraArgs,
        prompt,
      ],
    };
  },

  parseOutput(raw: string): ParsedOutput {
    try {
      const jsonStart = raw.indexOf('{');
      const json = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw) as {
        response?: string;
        error?: { message?: string };
      };
      const finalMessage = json.response ?? json.error?.message ?? raw;
      return {
        finalMessage,
        isError: json.error !== undefined,
        denials: findDenialPhrases(finalMessage),
      };
    } catch {
      return { finalMessage: raw, isError: false, denials: findDenialPhrases(raw) };
    }
  },
};
