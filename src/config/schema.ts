import { z } from 'zod';

/**
 * handsfree never asks an agent to pre-approve its own side effects: the whole
 * point of speaking ACP is that permission requests come back to us. A launch
 * profile carrying a bypass flag would silently reinstate the thing this design
 * exists to remove, so those flags are refused at config load.
 */
export const FORBIDDEN_LAUNCH_ARGS: { pattern: RegExp; reason: string; only?: RegExp }[] = [
  { pattern: /dangerously/i, reason: 'permission bypass' },
  { pattern: /^--?yolo$/i, reason: 'approve-everything mode' },
  // Scoped to the agent it belongs to: `-y` means yolo to gemini and "do not
  // prompt" to npx, which is how every adapter that ships through npx starts.
  { pattern: /^-y$/, reason: 'approve-everything mode', only: /^gemini$/ },
  { pattern: /danger-full-access/i, reason: 'unrestricted sandbox' },
  { pattern: /bypassPermissions/i, reason: 'permission bypass' },
  { pattern: /^--approval-mode$/i, reason: 'approval policy belongs to handsfree, not the adapter' },
  { pattern: /^--permission-mode$/i, reason: 'approval policy belongs to handsfree, not the adapter' },
];

export function assertLaunchArgsAllowed(args: string[], where: string, command = ''): void {
  const name = command.split(/[\\/]/).pop() ?? '';
  for (const arg of args) {
    for (const { pattern, reason, only } of FORBIDDEN_LAUNCH_ARGS) {
      if (only && !only.test(name)) continue;
      if (pattern.test(arg)) {
        throw new Error(
          `Refusing launch argument "${arg}" in ${where}: ${reason}. ` +
            'handsfree runs ACP agents in their default permission mode and answers ' +
            'session/request_permission itself.',
        );
      }
    }
  }
}

export const AgentProfileSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Executable that speaks ACP over stdio. */
    command: z.string(),
    args: z.array(z.string()).default([]),
    /** Extra environment for the child. The parent environment is passed through. */
    env: z.record(z.string(), z.string()).default({}),
    /** One-line capability note used when routing. Overridden by what `initialize` reports. */
    note: z.string().default(''),
  })
  .superRefine((profile, ctx) => {
    try {
      assertLaunchArgsAllowed(profile.args, 'agent args', profile.command);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message, path: ['args'] });
    }
  });
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * Launch profiles as of the adapters that exist today. `claude` and `codex` have
 * no native ACP mode, so they go through Zed's adapters; `gemini` speaks ACP
 * itself but has renamed the flag once already, hence the probe list.
 */
export const DEFAULT_AGENTS: Record<string, z.input<typeof AgentProfileSchema>> = {
  claude: {
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp'],
    note: 'general coding agent, strong at multi-file edits',
  },
  gemini: {
    command: 'gemini',
    // The model is pinned on purpose: left to itself the CLI picks a default
    // that is already retired for new keys, and the turn fails with a generic
    // "Internal error" the first time you prompt it.
    args: ['--experimental-acp', '-m', 'gemini-3.5-flash'],
    note: 'fast, good at bulk text and single-file work',
  },
  codex: {
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
    note: 'methodical coding agent, good at tests and refactors',
  },
};

const Rule = z.enum(['allow', 'ask', 'deny']);
export type RuleOutcome = z.infer<typeof Rule>;

export const PolicySchema = z
  .object({
    /** Every path an agent touches must resolve inside the session workspace. */
    workspaceOnly: z.boolean().default(true),
    fs: z
      .object({
        read: Rule.default('allow'),
        write: Rule.default('allow'),
        /** Applied when a path resolves outside the workspace roots. */
        outside: Rule.default('deny'),
        /** Refuse to follow a symlink whose target escapes the workspace. */
        followSymlinks: z.boolean().default(false),
      })
      .prefault({}),
    exec: z
      .object({
        /** Off by default: a file-only host has a much smaller blast radius. */
        enabled: z.boolean().default(false),
        mode: z.enum(['allowlist', 'ask', 'deny']).default('allowlist'),
        /** Token-prefix patterns, e.g. "git status", "pnpm test". */
        allow: z.array(z.string()).default([]),
        /** Commands are run directly; a shell script argument needs its own verdict. */
        shellOperators: Rule.default('deny'),
        timeoutMs: z.number().int().positive().default(120_000),
        outputByteLimit: z.number().int().positive().default(256 * 1024),
        /** Environment variables forwarded to commands. Everything else is dropped. */
        env: z.array(z.string()).default(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR']),
      })
      .prefault({}),
    /** What to do with an `ask` verdict, in order. An empty list means deny. */
    escalation: z.array(z.enum(['user'])).default(['user']),
    /** How long a human has to answer before the request is denied. */
    decisionTimeoutMs: z.number().int().positive().default(120_000),
  })
  .prefault({});
export type Policy = z.infer<typeof PolicySchema>;

export const ConfigSchema = z.object({
  /** Where session workspaces are created. Resolved to an absolute path at load. */
  workspaceRoot: z.string().default(''),
  llm: z
    .object({
      baseURL: z.string().default('http://localhost:1234/v1'),
      model: z.string().default('google/gemma-3-12b'),
      apiKey: z.string().default('not-needed'),
      temperature: z.number().min(0).max(2).default(0.1),
      timeoutMs: z.number().int().positive().default(120_000),
      /** Local models have small context windows; history is trimmed to this. */
      maxHistoryMessages: z.number().int().positive().default(30),
    })
    .prefault({}),
  agents: z.record(z.string(), AgentProfileSchema).prefault(DEFAULT_AGENTS),
  capabilities: z
    .object({
      readTextFile: z.boolean().default(true),
      writeTextFile: z.boolean().default(true),
      /** Declaring this makes handsfree the owner of every shell command. */
      terminal: z.boolean().default(false),
      elicitation: z.boolean().default(true),
    })
    .prefault({}),
  policy: PolicySchema,
  limits: z
    .object({
      /**
       * How long an adapter has to answer `initialize`. Generous, because an
       * adapter fetched through `npx` downloads itself on first use — but never
       * unbounded, or a wedged adapter wedges handsfree.
       */
      handshakeTimeoutMs: z.number().int().positive().default(90_000),
      /** Wall clock for a single session/prompt. */
      turnTimeoutMs: z.number().int().positive().default(600_000),
      /** No session/update for this long and the turn is cancelled. */
      idleTimeoutMs: z.number().int().positive().default(180_000),
      /** How long to wait for a `cancelled` stop reason before killing the process. */
      cancelGraceMs: z.number().int().positive().default(10_000),
      maxDelegationsPerTurn: z.number().int().positive().default(3),
      maxPlanSteps: z.number().int().positive().default(6),
      maxResultChars: z.number().int().positive().default(4000),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AgentId = string;
