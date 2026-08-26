import { z } from 'zod';

/**
 * Enterprise invariant: permission-bypass modes are forbidden and must be
 * unrepresentable. The enums below omit bypass values on purpose, and every
 * free-form `extraArgs` array is scanned against this denylist at load time.
 */
export const FORBIDDEN_ARG_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /dangerously/i, reason: 'permission/sandbox bypass flags are forbidden' },
  { pattern: /yolo/i, reason: 'gemini yolo mode is forbidden' },
  { pattern: /danger-full-access/i, reason: 'codex full-access sandbox is forbidden' },
  { pattern: /bypassPermissions/i, reason: 'claude bypassPermissions mode is forbidden' },
  { pattern: /^-y$/, reason: 'gemini -y (yolo) is forbidden' },
];

export function assertNoForbiddenArgs(args: string[], where: string): void {
  for (const arg of args) {
    for (const { pattern, reason } of FORBIDDEN_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        throw new Error(
          `Forbidden flag in ${where}: "${arg}" — ${reason}. ` +
            'handsfree never runs frontier CLIs with permission bypass.',
        );
      }
    }
  }
}

/**
 * The same invariant one level down. Blocking bypass *flags* is pointless if the
 * tool allowlist can hand the agent a shell anyway, so shell/network/subagent
 * tools are refused at config load exactly like the flags above. Tool names may
 * carry a scope suffix (`Bash(git:*)`), hence the prefix match.
 */
export const FORBIDDEN_TOOL_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^Bash/i, reason: 'shell execution is outside handsfree’s file-only scope' },
  { pattern: /^BashOutput/i, reason: 'shell execution is outside handsfree’s file-only scope' },
  { pattern: /^KillShell/i, reason: 'shell execution is outside handsfree’s file-only scope' },
  { pattern: /^WebFetch/i, reason: 'network access is outside handsfree’s scope' },
  { pattern: /^WebSearch/i, reason: 'network access is outside handsfree’s scope' },
  { pattern: /^Task/i, reason: 'subagents would run at a scope handsfree cannot audit' },
];

export function assertNoForbiddenTools(tools: string[], where: string): void {
  for (const tool of tools) {
    for (const { pattern, reason } of FORBIDDEN_TOOL_PATTERNS) {
      if (pattern.test(tool)) {
        throw new Error(
          `Forbidden tool in ${where}: "${tool}" — ${reason}. ` +
            'handsfree grants delegated agents file-level tools only.',
        );
      }
    }
  }
}

const extraArgs = z
  .array(z.string())
  .default([])
  .superRefine((args, ctx) => {
    try {
      assertNoForbiddenArgs(args, 'extraArgs');
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message });
    }
  });

const agentBase = {
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(300_000),
  model: z.string().optional(),
  extraArgs,
};

export const ConfigSchema = z.object({
  llm: z
    .object({
      baseURL: z.url().default('http://localhost:1234/v1'),
      model: z.string().default('google/gemma-3-12b'),
      apiKey: z.string().default('not-needed'),
      temperature: z.number().min(0).max(2).default(0.1),
      /** Per-request ceiling. A wedged local server must not wedge handsfree. */
      timeoutMs: z.number().int().positive().default(120_000),
    })
    .prefault({}),
  orchestrator: z
    .object({
      maxTurns: z.number().int().positive().default(6),
      maxDelegationsPerMessage: z.number().int().positive().default(3),
      maxResultChars: z.number().int().positive().default(4000),
      /**
       * Conversation messages kept after the system prompt. Local models have
       * small context windows; an untrimmed history degrades them silently.
       */
      maxHistoryMessages: z.number().int().positive().default(40),
    })
    .prefault({}),
  workspaceRoot: z.string().default(''),
  agents: z
    .object({
      claude: z
        .object({
          ...agentBase,
          command: z.string().default('claude'),
          // "bypassPermissions" deliberately not representable
          permissionMode: z.enum(['default', 'acceptEdits', 'plan']).default('acceptEdits'),
          allowedTools: z
            .array(z.string())
            .default(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
            .superRefine((tools, ctx) => {
              try {
                assertNoForbiddenTools(tools, 'allowedTools');
              } catch (err) {
                ctx.addIssue({ code: 'custom', message: (err as Error).message });
              }
            }),
        })
        .prefault({}),
      gemini: z
        .object({
          ...agentBase,
          command: z.string().default('gemini'),
          // Explicit default model: the CLI's auto-router depends on models
          // that are unavailable to new API keys.
          model: z.string().optional().default('gemini-3.5-flash'),
          // "yolo" deliberately not representable
          approvalMode: z.enum(['default', 'auto_edit']).default('auto_edit'),
        })
        .prefault({}),
      codex: z
        .object({
          ...agentBase,
          command: z.string().default('codex'),
          // "danger-full-access" deliberately not representable
          sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AgentName = 'claude' | 'gemini' | 'codex';
