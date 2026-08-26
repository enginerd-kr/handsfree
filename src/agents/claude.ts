import type { Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';
import type { AgentAdapter, AgentOutput, Invocation, ParsedOutput } from './types.js';
import { findDenialPhrases } from './denials.js';
import { parseJsonObject } from './json.js';

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

  parseOutput({ stdout, stderr }: AgentOutput): ParsedOutput {
    const json = parseJsonObject(stdout) as
      | { result?: string; is_error?: boolean; permission_denials?: unknown[] }
      | null;

    if (!json) {
      // We asked for `--output-format json` and did not get it, so the run failed
      // before producing a result. stderr is where the reason lives.
      const text = stdout.trim() || stderr.trim();
      return {
        finalMessage: text,
        isError: true,
        denials: [],
        denialHints: findDenialPhrases(`${stdout}\n${stderr}`),
      };
    }

    const denials = Array.isArray(json.permission_denials)
      ? json.permission_denials.map((d) => JSON.stringify(d).slice(0, 200))
      : [];
    const finalMessage = json.result ?? stdout.trim();
    return {
      finalMessage,
      isError: json.is_error === true,
      denials,
      denialHints: findDenialPhrases(finalMessage),
    };
  },
};
