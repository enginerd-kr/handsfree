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
 * Environment for every process handsfree starts, keyed by the variable's own
 * name. This exists because the shell is the wrong place to fix a corporate
 * network: agents are spawned directly, so rc-file aliases never apply to
 * them, and `HTTP_PROXY=` in a shell sets an empty string rather than
 * unsetting. Here the semantics are explicit — a variable that is omitted
 * inherits the shell's value, `null` removes it entirely, and a string sets
 * it — and nothing is renamed on the way through, so `HTTPS_PROXY`,
 * `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED` and whatever else a
 * network needs are all spelled exactly as the tools read them. Set both
 * spellings of a proxy variable yourself when a tool insists on the lower
 * one. An agent profile's `env` still wins over this block.
 */
export const EnvSchema = z.record(z.string(), z.string().nullable()).prefault({});
export type EnvConfig = z.infer<typeof EnvSchema>;

const Rule = z.enum(['allow', 'ask', 'deny']);
export type RuleOutcome = z.infer<typeof Rule>;

/**
 * What a coding task reaches for before it reaches for anything else: reading
 * the workspace, asking git what it looks like, and the verbs that close the
 * loop on a change — run the tests, build, typecheck. Nothing on this list
 * writes a file of its own or rewrites history, so nothing on it needs a person.
 *
 * Everything else is not refused: it is `exec.otherwise`, and out of the box
 * `otherwise` is a person. Installing, committing, `curl`, a script the agent
 * wrote a moment ago — those are decisions, and they are shown as one.
 *
 * `find` is the deliberate omission. `-delete` and `-exec` make it a mutation
 * tool wearing a reader's name, and entries match on a prefix.
 */
export const DEV_ALLOWLIST = [
  // Looking around.
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'pwd',
  'echo',
  'which',
  'tree',
  'diff',
  'grep',
  'rg',
  // Git, as far as reading it goes.
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'git blame',
  'git remote -v',
  // Closing the loop on a change. These run the project's own scripts, which is
  // the point: an agent that cannot run the tests cannot tell you they pass.
  'pnpm test',
  'pnpm build',
  'pnpm typecheck',
  'pnpm lint',
  'npm test',
  'npm run build',
  'npm run test',
  'yarn test',
  'yarn build',
  'cargo check',
  'cargo build',
  'cargo test',
  'go build',
  'go test',
  'go vet',
  'pytest',
  'ruff check',
  'mypy',
  'make test',
  'make build',
];


/**
 * What each agent is for, in the words the planner is given. Keyed by agent id.
 *
 * This sits outside `agents` on purpose. A profile under `agents` is taken
 * whole when two config files are layered — a launch line spliced from two
 * files is a command nobody wrote — but a role is the opposite kind of thing:
 * the line a checkout most wants to say on its own, and making it restate the
 * command and the arguments to do so is a tax on the one edit worth making.
 * Here it is an ordinary record, so it merges name by name: a project file that
 * re-describes `codex` leaves the user's line for `gemini` standing.
 *
 * A name nothing configures is refused rather than dropped, because a role that
 * never reaches the planner and a role the planner ignored read the same from
 * where you are sitting.
 */
export const RolesSchema = z.record(z.string(), z.string().min(1)).prefault({});
export type Roles = z.infer<typeof RolesSchema>;

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
        /**
         * On, because an agent that cannot run the tests cannot tell you they
         * pass — it can only tell you it thinks so. The blast radius is held by
         * the three things below rather than by the switch: commands run in the
         * workspace and nowhere else, the allowlist says what needs no person,
         * and everything it does not name is shown to one.
         */
        enabled: z.boolean().default(true),
        mode: z.enum(['allowlist', 'ask', 'deny']).default('allowlist'),
        /** Token-prefix patterns, e.g. "git status", "pnpm test". */
        allow: z.array(z.string()).default(DEV_ALLOWLIST),
        /**
         * A command the allowlist does not name. `ask` rather than `deny`
         * because a coding agent legitimately reaches past any list somebody
         * wrote in advance, and the question is who decides — not whether the
         * list is complete. With nobody to ask, an `ask` is a denial, so
         * `handsfree run` and CI stay exactly as tight as they were.
         */
        otherwise: Rule.default('ask'),
        /**
         * A redirect, a substitution, a chain with a link the allowlist does
         * not name — the part of the script we stop reading at. Judged by a
         * person, who is shown the whole script, because emulating a shell
         * well enough to decide it is not a thing we are going to do. A plain
         * chain of allowed commands — `cd src && pnpm test`, `node a && node
         * b` — never gets here: each link is judged as the command it is.
         */
        shellOperators: Rule.default('ask'),
        timeoutMs: z.number().int().positive().default(120_000),
        /**
         * The most of a command's output an agent is handed back, kept from
         * the end — that is where a failing test names itself. An agent may ask
         * for less. What was cut is written whole under the run directory, for
         * a person; the agent's window is the thing this exists to protect.
         */
        outputByteLimit: z.number().int().positive().default(64 * 1024),
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
  /**
   * How much the planner is sent per call, in estimated tokens: the system
   * prompt, the run state, the history and the line being answered. Older
   * turns go first when it is over, then the run state shortens. Unset, a
   * local endpoint gets 8,000 and a frontier agent over ACP gets 32,000 — the
   * one has a small window and the other pays by the token.
   */
  contextBudgetTokens: z.number().int().positive().optional(),
  /**
   * Whether the planner is handed an agent's whole reply after a task, the
   * way it used to be, so it can repeat it to the user. Off, it gets the
   * report's summary and a note that the user has already seen the reply —
   * which they have, on screen, as it streamed. On, for a client that shows
   * only handsfree's own replies.
   */
  relayAnswers: z.boolean().default(false),
});

/** The planner's budget, with the provider deciding it where the config did not. */
export function contextBudgetTokens(orchestration: Orchestration): number {
  return orchestration.contextBudgetTokens ?? (orchestration.provider === 'acp' ? 32_000 : 8_000);
}
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
    env: EnvSchema,
    agents: z.record(z.string(), AgentProfileSchema).prefault(DEFAULT_AGENTS),
    roles: RolesSchema,
    capabilities: z
      .object({
        readTextFile: z.boolean().default(true),
        writeTextFile: z.boolean().default(true),
        /**
         * Declaring this makes handsfree the owner of every shell command: it
         * runs in the workspace, with the environment `policy.exec.env` allows
         * and an output ceiling. Undeclared, an agent that wants a command runs
         * it in its own shell instead — the one place a policy decision does not
         * reach — so this follows `policy.exec.enabled` rather than sitting off.
         */
        terminal: z.boolean().default(true),
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
        /**
         * Longest a task result handed to the planner is. Small, because what
         * it carries is the report's summary and open items, not the reply.
         */
        maxResultChars: z.number().int().positive().default(1200),
        /** Longest the "since your last task" section of a brief is. */
        handoffBudgetChars: z.number().int().positive().default(1600),
        /** Longest a report's summary is kept, from the agent's REPORT block or the fallback. */
        reportSummaryChars: z.number().int().positive().default(300),
        /**
         * How many tasks an agent's session gets between repeats of the ground
         * rules. The session keeps its own memory, but a long one is compacted
         * by the agent and what goes first is what was said first — the brief
         * that explained the jail. A repeat is a hundred tokens; being told
         * about it is not something a session can do.
         */
        rebriefEveryTasks: z.number().int().positive().default(8),
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
    for (const id of Object.keys(config.roles)) {
      if (config.agents[id]) continue;
      ctx.addIssue({
        code: 'custom',
        message:
          `roles describes "${id}", but no such agent is configured. ` +
          `Configured: ${Object.keys(config.agents).join(', ') || '(none)'}.`,
        path: ['roles', id],
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

/**
 * The one line the planner is told about an agent: the role a config file wrote
 * for it, and failing that the launch profile's own note. Empty means nobody
 * said, and the caller decides what an undescribed agent is called.
 */
export function agentRole(config: Config, id: AgentId): string {
  return config.roles[id] ?? config.agents[id]?.note ?? '';
}
