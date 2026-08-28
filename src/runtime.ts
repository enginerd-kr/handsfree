import type { Config } from './config/schema.js';
import type { ConfigLocation } from './config/load.js';
import { AcpModel } from './brain/acp.js';
import { LocalModel, type ChatClient } from './brain/client.js';
import { PolicyEngine } from './policy/engine.js';
import type { Escalator } from './policy/types.js';
import { AgentPool, type PoolOptions } from './host/pool.js';
import { Conversation } from './orchestrator/conversation.js';
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
  /** Work in a directory that already exists, such as an editor's project root. */
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
    ? Workspace.attach(options.attachTo, config.workspaceRoot)
    : Workspace.open(config.workspaceRoot, options.runId);
  const transcript = new Transcript(workspace.transcriptFile);
  const jail = workspace.jail(config.policy);

  const policy = new PolicyEngine({
    policy: config.policy,
    jail,
    escalator: options.escalator,
    onDecision: (entry) => {
      transcript.append({ type: 'decision', agentId: entry.request.agentId, entry });
    },
  });

  const pool = new AgentPool({
    config,
    workspace,
    jail,
    policy,
    transcript,
    createTarget: options.createTarget,
  });
  let brain: AcpModel | undefined;
  let llm: ChatClient | undefined;
  if ('llm' in options) {
    llm = options.llm;
  } else if (config.orchestration.provider === 'acp') {
    const agentId = config.orchestration.acp.agent;
    const profile = config.agents[agentId];
    if (!profile) throw new Error(`orchestration wants agent "${agentId}", which is not configured.`);
    brain = new AcpModel({
      agentId,
      profile,
      // Its own agent id, so its sessions never overwrite the saved ids the
      // pool resumes from — and its own in-memory transcript, so planning
      // chatter never renders as agent output. Decisions still reach the main
      // transcript through the shared policy engine.
      host: { agentId: 'orchestrator', config, workspace, jail, policy, transcript: new Transcript() },
      timeoutMs: config.orchestration.acp.timeoutMs,
      cancelGraceMs: config.limits.cancelGraceMs,
      createTarget: options.createTarget,
    });
    llm = brain;
  } else {
    llm = new LocalModel(config.orchestration.local);
  }
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

  const conversation = new Conversation({
    config,
    pool,
    transcript,
    workspace,
    llm,
    commands: registry.commands,
    commandHost,
  });

  return {
    config,
    workspace,
    transcript,
    jail,
    policy,
    pool,
    conversation,
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
      await Promise.all([pool.closeAll(), brain?.close()]);
      await conversationDone;
      await transcript.close();
    },
  };
}
