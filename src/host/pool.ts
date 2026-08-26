import type { AgentProfile, Config } from '../config/schema.js';
import type { HostContext } from '../capabilities/context.js';
import type { ConnectionTarget } from './connection.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { Jail } from '../policy/jail.js';
import type { Transcript } from '../workspace/transcript.js';
import type { Workspace } from '../workspace/workspace.js';
import { AgentConnection } from './connection.js';
import { fallbackArgs, spawnTarget } from './launch.js';
import type { HostSession } from './session.js';

export interface PoolOptions {
  config: Config;
  workspace: Workspace;
  jail: Jail;
  policy: PolicyEngine;
  transcript: Transcript;
  /**
   * How an agent is reached. Production spawns a process; tests connect an
   * in-process agent app, which is the only way to script a refusal, a stalled
   * turn, or a path escape on demand.
   */
  createTarget?: (agentId: string, profile: AgentProfile) => ConnectionTarget;
}

/**
 * Agents are expensive to start (an adapter fetched by `npx` can take seconds)
 * and cheap to keep, so a connection and its session live for the whole run.
 * Keeping the session is also what lets a second task build on the first without
 * replaying context through files.
 */
export class AgentPool {
  private readonly connections = new Map<string, AgentConnection>();
  private readonly sessions = new Map<string, HostSession>();
  private readonly opening = new Map<string, Promise<AgentConnection>>();

  constructor(private readonly options: PoolOptions) {}

  /** Agent ids that are switched on, in config order. */
  available(): string[] {
    return Object.entries(this.options.config.agents)
      .filter(([, profile]) => profile.enabled)
      .map(([id]) => id);
  }

  isOpen(agentId: string): boolean {
    return this.connections.has(agentId);
  }

  async connection(agentId: string): Promise<AgentConnection> {
    const existing = this.connections.get(agentId);
    if (existing) return existing;
    const pending = this.opening.get(agentId);
    if (pending) return pending;

    const attempt = this.open(agentId).finally(() => this.opening.delete(agentId));
    this.opening.set(agentId, attempt);
    return attempt;
  }

  /** The one session handsfree keeps with this agent for the current run. */
  async session(agentId: string): Promise<HostSession> {
    const existing = this.sessions.get(agentId);
    if (existing) return existing;

    const connection = await this.connection(agentId);
    const saved = this.options.workspace.readSessionIds()[agentId];
    const resumed = saved ? await connection.loadSession(saved) : undefined;
    if (resumed) {
      this.options.transcript.append({
        type: 'note',
        level: 'info',
        text: `resumed ${agentId} session ${saved}`,
      });
    }
    const session = resumed ?? (await connection.newSession());
    this.sessions.set(agentId, session);
    return session;
  }

  /** Drops a wedged agent so the next request starts a fresh process. */
  async discard(agentId: string): Promise<void> {
    this.sessions.delete(agentId);
    const connection = this.connections.get(agentId);
    this.connections.delete(agentId);
    await connection?.close();
  }

  async closeAll(): Promise<void> {
    const open = [...this.connections.values()];
    this.connections.clear();
    this.sessions.clear();
    await Promise.all(open.map((connection) => connection.close()));
  }

  private async open(agentId: string): Promise<AgentConnection> {
    const profile = this.options.config.agents[agentId];
    if (!profile) throw new Error(`No agent named "${agentId}" is configured.`);
    if (!profile.enabled) throw new Error(`Agent "${agentId}" is switched off in config.`);

    const host: HostContext = {
      agentId,
      config: this.options.config,
      workspace: this.options.workspace,
      jail: this.options.jail,
      policy: this.options.policy,
      transcript: this.options.transcript,
    };

    const attempts = [profile.args, fallbackArgs(profile.args)].filter(
      (args): args is string[] => args !== undefined,
    );

    let lastError: Error | undefined;
    for (const args of attempts) {
      const profileForAttempt = { ...profile, args };
      const target = this.options.createTarget
        ? this.options.createTarget(agentId, profileForAttempt)
        : spawnTarget(profileForAttempt, {
            cwd: this.options.workspace.dir,
            onStderr: (text) =>
              this.options.transcript.append({ type: 'agent_stderr', agentId, text }),
          });
      try {
        const connection = await AgentConnection.open({ agentId, host, target });
        this.connections.set(agentId, connection);
        return connection;
      } catch (err) {
        lastError = err as Error;
        await target.close();
      }
    }
    throw lastError ?? new Error(`Could not start ${agentId}.`);
  }
}
