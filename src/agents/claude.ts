import type { Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';
import type { AgentAdapter, Invocation, ParsedOutput } from './types.js';
import { findDenialPhrases } from './denials.js';

export const claudeAdapter: AgentAdapter = {
  name: 'claude',

  buildInvocation(prompt: string, _task: TaskPaths, runDir: string, config: Config): Invocation {
    const cfg = config.agents.claude;
    return {
      command: cfg.command,
      args: [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--permission-mode',
        cfg.permissionMode,
        '--allowedTools',
        ...cfg.allowedTools,
        '--add-dir',
        runDir,
        ...(cfg.model ? ['--model', cfg.model] : []),
        ...cfg.extraArgs,
      ],
    };
  },

  parseOutput(raw: string): ParsedOutput {
    try {
      const json = JSON.parse(raw) as {
        result?: string;
        is_error?: boolean;
        permission_denials?: unknown[];
      };
      const denials: string[] = [];
      if (Array.isArray(json.permission_denials) && json.permission_denials.length > 0) {
        denials.push(
          ...json.permission_denials.map((d) => JSON.stringify(d).slice(0, 200)),
        );
      }
      const finalMessage = json.result ?? raw;
      denials.push(...findDenialPhrases(finalMessage));
      return { finalMessage, isError: json.is_error === true, denials };
    } catch {
      return { finalMessage: raw, isError: false, denials: findDenialPhrases(raw) };
    }
  },
};
