import type { Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';
import type { AgentAdapter, AgentOutput, Invocation, ParsedOutput } from './types.js';
import { findDenialPhrases } from './denials.js';
import { parseJsonObject } from './json.js';

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

  parseOutput({ stdout, stderr }: AgentOutput): ParsedOutput {
    const json = parseJsonObject(stdout) as
      | { response?: string; error?: { message?: string } }
      | null;

    if (!json) {
      const text = stdout.trim() || stderr.trim();
      return {
        finalMessage: text,
        isError: true,
        denials: [],
        denialHints: findDenialPhrases(`${stdout}\n${stderr}`),
      };
    }

    const finalMessage = json.response ?? json.error?.message ?? stdout.trim();
    return {
      finalMessage,
      isError: json.error !== undefined,
      // gemini reports refusals in prose, not structurally — hints are all we get.
      denials: [],
      denialHints: findDenialPhrases(finalMessage),
    };
  },
};
