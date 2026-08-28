import { z } from 'zod';
import { ORCHESTRATOR } from '../mention/mention.js';

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
    /**
     * Extra environment for the child. The parent environment is passed
     * through; `null` removes an inherited variable instead of setting it.
     */
    env: z.record(z.string(), z.string().nullable()).default({}),
    /** One-line capability note used when routing. Overridden by what `initialize` reports. */
    note: z.string().default(''),
    /**
     * The model every session with this agent is put on when it opens, matched
     * against the roster the agent advertises the way a `:model` mention is.
     * Optional, and usually absent: every adapter handsfree ships with is the
     * CLI's own current one, so the default it comes up on is the CLI's. Set
     * it only to override that.
     */
    model: z.string().min(1).optional(),
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
 * Launch profiles as of the adapters that exist today, each the one the ACP
 * registry names as canonical. None pins a model: every one of these adapters
 * is the CLI's own current adapter, so the roster it advertises and the model
 * it comes up on are the CLI's. A profile only needs `model` to disagree with
 * that.
 */
export const DEFAULT_AGENTS: Record<string, z.input<typeof AgentProfileSchema>> = {
  claude: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    note: 'general coding agent, strong at multi-file edits',
  },
  gemini: {
    command: 'gemini',
    // The CLI speaks ACP itself, so there is no adapter to fall behind it.
    // The flag was renamed once; `fallbackArgs` tries the older spelling.
    args: ['--acp'],
    note: 'fast, good at bulk text and single-file work',
  },
  codex: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    note: 'methodical coding agent, good at tests and refactors',
  },
};

/**
 * Proxy configuration for every process handsfree starts. This exists because
 * the shell is the wrong place to fix a corporate proxy: agents are spawned
 * directly, so rc-file aliases never apply to them, and `HTTP_PROXY=` in a
 * shell sets an empty string rather than unsetting. Here the semantics are
 * explicit — a key that is omitted inherits the shell's value, `""` removes
 * the variable entirely, and anything else sets it — and each key writes both
 * spellings (`HTTPS_PROXY` and `https_proxy`), since tools disagree on which
 * one they read. An agent profile's `env` still wins over this block.
 */
export const ProxySchema = z
  .object({
    /** HTTP_PROXY / http_proxy */
    http: z.string().optional(),
    /** HTTPS_PROXY / https_proxy — the one API traffic actually reads. */
    https: z.string().optional(),
    /** ALL_PROXY / all_proxy */
    all: z.string().optional(),
    /** NO_PROXY / no_proxy */
    noProxy: z.string().optional(),
  })
  .prefault({});
export type ProxyConfig = z.infer<typeof ProxySchema>;

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

/**
 * The model that plans and summarises. Both ways of running it are configured
 * side by side and `provider` picks the live one, so switching between a local
 * endpoint and a frontier agent is a one-word edit, not a rewrite.
 */
export const OrchestrationSchema = z.object({
  provider: z.enum(['local', 'acp']).default('local'),
  /** An OpenAI-compatible endpoint: LM Studio, Ollama, llama.cpp. */
  local: z
    .object({
      baseURL: z.string().default('http://localhost:1234/v1'),
      model: z.string().default('google/gemma-3-12b'),
      apiKey: z.string().default('not-needed'),
      temperature: z.number().min(0).max(2).default(0.1),
      timeoutMs: z.number().int().positive().default(120_000),
    })
    .prefault({}),
  /** A frontier model reached by driving one of the configured agents over ACP. */
  acp: z
    .object({
      /** Which entry in `agents` does the planning. */
      agent: z.string().default('claude'),
      /**
       * The model it plans on, matched against the agent's own roster the way
       * a `:model` mention is. Worth naming apart from the agents that do the
       * work: routing and summarising is small, cheap, high-frequency work,
       * and the model that is right for it is rarely the one you want editing
       * your files. Left out, the planner takes the agent profile's `model`,
       * and failing that the agent's own default.
       */
      model: z.string().min(1).optional(),
      /** Wall clock for a single planning or summary reply. */
      timeoutMs: z.number().int().positive().default(120_000),
    })
    .prefault({}),
  /** Local models have small context windows; history is trimmed to this. */
  maxHistoryMessages: z.number().int().positive().default(30),
});
export type Orchestration = z.infer<typeof OrchestrationSchema>;

export const ConfigSchema = z
  .object({
    /** Where session workspaces are created. Resolved to an absolute path at load. */
    workspaceRoot: z.string().default(''),
    /**
     * Runs older than this many days are deleted shortly after startup —
     * transcript, sessions and workspace together. 0 turns pruning off and
     * keeps everything forever.
     */
    cleanupPeriodDays: z.number().int().nonnegative().default(30),
    orchestration: OrchestrationSchema.prefault({}),
    proxy: ProxySchema,
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
  })
  .superRefine((config, ctx) => {
    // `@orchestrator:agent:model` moves the planner, so the name is spoken for.
    // An agent wearing it could never be addressed, and the mention would mean
    // two things at once.
    if (config.agents[ORCHESTRATOR]) {
      ctx.addIssue({
        code: 'custom',
        message:
          `"${ORCHESTRATOR}" is what a mention calls the planner ` +
          `(@${ORCHESTRATOR}:agent:model), so an agent cannot be named that.`,
        path: ['agents', ORCHESTRATOR],
      });
    }
    const { provider, acp } = config.orchestration;
    if (provider === 'acp' && !config.agents[acp.agent]) {
      ctx.addIssue({
        code: 'custom',
        message:
          `orchestration wants agent "${acp.agent}", but no such agent is configured. ` +
          `Configured: ${Object.keys(config.agents).join(', ') || '(none)'}.`,
        path: ['orchestration', 'acp', 'agent'],
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type AgentId = string;

/**
 * The model the planner runs on when `provider` is `acp`: the one orchestration
 * names, or failing that the agent profile's, since a session with that agent
 * is what the planner opens. Nothing means the agent's own default, which only
 * the agent knows.
 */
export function orchestrationModel(config: Config): string | undefined {
  const { acp } = config.orchestration;
  return acp.model ?? config.agents[acp.agent]?.model;
}
