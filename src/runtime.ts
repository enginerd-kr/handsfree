import { orchestrationModel, type Config } from './config/schema.js';
import type { ConfigLocation } from './config/load.js';
import { AcpModel } from './brain/acp.js';
import { LocalModel, type ChatClient } from './brain/client.js';
import { Planner, type OrchestrationChoice } from './brain/planner.js';
import { PolicyEngine } from './policy/engine.js';
import type { Escalator } from './policy/types.js';
import type { PermissionMode } from './policy/mode.js';
import { AgentPool, type PoolOptions } from './host/pool.js';
import { resolveModel } from './host/models.js';
import { Conversation } from './orchestrator/conversation.js';
import { Executor } from './orchestrator/executor.js';
import { UsageTracker } from './orchestrator/meter.js';
import { workspaceScheduler } from './orchestrator/scheduler.js';
import { Transcript } from './workspace/transcript.js';
import { pruneOldRuns } from './workspace/prune.js';
import { Workspace } from './workspace/workspace.js';
import type { Jail } from './policy/jail.js';
import { debug } from './debug.js';
import { loadCommands } from './slash/registry.js';
import type { Command, CommandHost } from './slash/command.js';

/** Long enough that pruning never races startup, short enough to actually run. */
const PRUNE_DELAY_MS = 5_000;

export interface RuntimeOptions {
  permissionMode?: PermissionMode;
  config: Config;
  /** The files the settings were read from, strongest first, for `/config` to name. */
  configSources?: readonly ConfigLocation[];
  /**
   * Where project files are looked up — the config's directory and the command
   * directory beside it. The workspace is never this: it is the agents' jail.
   */
  cwd?: string;
  /** Reuse an existing run directory instead of starting a new one. */
  runId?: string;
  /**
   * Work in a directory that already exists — the directory handsfree was
   * started in, or an editor's project root. Without one the workspace is a
   * fresh empty sandbox under the handsfree root.
   */
  attachTo?: string;
  /** Answers `ask` verdicts. Without one, every escalation is a denial. */
  escalator?: Escalator;
  llm?: ChatClient;
  /** Overridden by tests to connect an in-process agent instead of spawning one. */
  createTarget?: PoolOptions['createTarget'];
}

export interface Runtime {
  config: Config;
  workspace: Workspace;
  transcript: Transcript;
  jail: Jail;
  policy: PolicyEngine;
  pool: AgentPool;
  conversation: Conversation;
  executor: Executor;
  usage: UsageTracker;
  /** Every slash command this run knows, built once from disk. */
  commands: readonly Command[];
  /** A context for a command to act in, named after the command doing the asking. */
  commandHost(agentId: string): CommandHost;
  setEscalator(escalator: Escalator | undefined): void;
  close(): Promise<void>;
}

/**
 * Wires the host together. The order matters in one place: the policy engine is
 * given the transcript before any agent exists, so a decision made during the
 * very first request is already on the record.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { config } = options;
  const workspace = options.attachTo
    ? Workspace.attach(options.attachTo, config.workspaceRoot, options.runId)
    : Workspace.open(config.workspaceRoot, options.runId);
  const transcript = new Transcript(workspace.transcriptFile);
  const jail = workspace.jail();

  const policy = new PolicyEngine({
    decisionTimeoutMs: config.limits.decisionTimeoutMs,
    jail,
    escalator: options.escalator,
    onDecision: (entry) => {
      transcript.append({ type: 'decision', agentId: entry.request.agentId, entry });
    },
  });
  if (options.permissionMode) policy.setMode(options.permissionMode);

  const pool = new AgentPool({
    config,
    workspace,
    jail,
    policy,
    transcript,
    createTarget: options.createTarget,
  });
  /** The planner as an agent over ACP, on the model the config names for it. */
  const brainFor = (agentId: string, model: string | undefined): AcpModel => {
    const profile = config.agents[agentId];
    if (!profile) throw new Error(`No agent named "${agentId}" is configured.`);
    if (!profile.enabled) throw new Error(`Agent "${agentId}" is switched off in config.`);
    // Its own in-memory transcript, so planning chatter never renders as agent
    // output — but its remarks are not chatter: a question the orchestrator was
    // refused, or a file it wrote, is something the user has to be able to see.
    // Notes cross over; the streamed planning JSON does not.
    const aside = new Transcript();
    aside.on('record', (record) => {
      if (record.type === 'note') transcript.append(record);
    });
    return new AcpModel({
      agentId,
      profile,
      // Its own agent id, so its sessions never overwrite the saved ids the
      // pool resumes from. Decisions reach the main transcript through the
      // shared policy engine.
      host: { agentId: 'orchestrator', config, workspace, jail, policy, transcript: aside },
      // Its own model where one is named, since planning is not the work the
      // agents do; otherwise whatever the profile asks for, so that pinning a
      // model for an agent pins it for every session with that agent.
      ...(model === undefined ? {} : { model }),
      timeoutMs: config.orchestration.acp.timeoutMs,
      cancelGraceMs: config.limits.cancelGraceMs,
      createTarget: options.createTarget,
    });
  };

  // Held behind the Planner rather than handed over directly, because
  // `@orchestrator:agent:model` moves it mid-run and the conversation must not
  // be rebuilt to follow. A run with no planner at all — `doctor` — keeps none.
  let planner: Planner | undefined;
  if ('llm' in options) {
    if (options.llm) planner = new Planner(options.llm);
  } else if (config.orchestration.provider === 'acp') {
    const brain = brainFor(config.orchestration.acp.agent, orchestrationModel(config));
    planner = new Planner(brain, brain);
  } else {
    planner = new Planner(new LocalModel(config.orchestration.local));
  }

  /**
   * The id the agent actually offers, where a session of its own has already
   * answered with a roster: someone types `opus` and what is written down
   * should be `opus[1m]`. Where nothing has answered yet there is nothing to
   * match against, so the name stands as typed and the planner's own session
   * settles it at the next turn.
   */
  const nameModel = (agentId: string, wanted: string): string => {
    const roster = pool.models(agentId);
    return roster.length === 0 ? wanted : resolveModel(wanted, roster, agentId).value;
  };

  /**
   * The planner moved to another agent, another model, or both — what
   * `@orchestrator:agent:model` asks for. It answers with the line to say so,
   * and throws what a person can act on where the move cannot be made.
   */
  const useOrchestration = async ({ agent, model }: OrchestrationChoice): Promise<string> => {
    if (!planner) throw new Error('there is no orchestration model here to move.');
    const profile = config.agents[agent];
    if (!profile) throw new Error(`No agent named "${agent}" is configured.`);
    if (!profile.enabled) throw new Error(`Agent "${agent}" is switched off in config.`);
    const named = model === undefined ? undefined : nameModel(agent, model);
    // Written down before the swap, so everything that reads the config —
    // /agents, doctor, the fall back to the agent's own profile — is
    // describing what is actually planning. Nothing after this can fail.
    const { orchestration } = config;
    orchestration.provider = 'acp';
    orchestration.acp.agent = agent;
    if (named === undefined) delete orchestration.acp.model;
    else orchestration.acp.model = named;
    const on = orchestrationModel(config);
    await planner.replace(brainFor(agent, on));
    return `orchestration: ${agent} over acp${on ? ` on ${on}` : ''}`;
  };
  const registry = loadCommands(options.cwd);
  debug(
    'commands',
    `${registry.commands.length} commands: ${registry.commands.map((command) => `/${command.name}`).join(' ')}`,
  );
  // Said once, where a person will see it: a command file that could not be
  // read is a command that will not be there when they reach for it.
  for (const problem of registry.problems) {
    transcript.append({ type: 'note', level: 'warn', text: problem });
  }
  const commandHost = (agentId: string): CommandHost => ({
    agentId,
    config,
    configSources: options.configSources ?? [],
    workspace,
    jail,
    policy,
    transcript,
    commands: registry.commands,
  });

  // Old runs are swept a beat after startup rather than during it: the delay
  // keeps disk housekeeping off the launch path, and an unref'd timer lets a
  // short-lived process exit without waiting around to clean. The current run
  // is named so the sweep can never eat the floor it stands on.
  const prune = setTimeout(() => {
    try {
      pruneOldRuns(config.workspaceRoot, config.cleanupPeriodDays, workspace.id);
    } catch (err) {
      debug('prune', `sweep failed: ${(err as Error).message}`);
    }
  }, PRUNE_DELAY_MS);
  prune.unref();

  const usage = new UsageTracker(config, transcript);
  const scheduling = workspaceScheduler(workspace.dir, config.execution.maxParallel);
  const executor = new Executor({ config, pool, transcript, workspace, policy, usage, llm: planner, scheduler: scheduling.scheduler });
  const conversation = new Conversation({
    config,
    pool,
    transcript,
    workspace,
    llm: planner,
    useOrchestration,
    commands: registry.commands,
    commandHost,
    executor,
    usage,
  });

  return {
    config,
    workspace,
    transcript,
    jail,
    policy,
    pool,
    conversation,
    executor,
    usage,
    commands: registry.commands,
    commandHost,
    setEscalator: (escalator) => policy.setEscalator(escalator),
    async close() {
      clearTimeout(prune);
      // The conversation goes first, and the agents are killed while it winds
      // down so its pending requests reject instead of running out a grace
      // period. Only once the turn has settled — nothing left that could
      // append — is the transcript ended.
      const conversationDone = conversation.close();
      const executionDone = executor.close();
      await Promise.all([pool.closeAll(), planner?.close()]);
      await conversationDone;
      await executionDone;
      usage.close();
      scheduling.release();
      await transcript.close();
    },
  };
}
