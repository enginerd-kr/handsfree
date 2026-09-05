import type { AgentProfile, Config } from '../config/schema.js';
import type { HostContext } from './capabilities/context.js';
import type { AgentConnection, ConnectionTarget } from './connection.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { Jail } from '../policy/jail.js';
import type { Transcript } from '../workspace/transcript.js';
import type { Workspace } from '../workspace/workspace.js';
import { mediationProblem } from './mediation.js';
import { openAgent } from './open.js';
import type { ModelChoice } from './models.js';
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
 * An agent that would not start, already on the record. The pool writes the
 * note the moment the attempt fails, once — every caller waiting on that
 * attempt gets this error, and none of them has to say it again. Without it
 * the roster probe and the first task sent to the agent, both waiting on the
 * one open, each reported the same failure, and the transcript carried the
 * sentence twice on consecutive rows.
 */
export class AgentStartError extends Error {
  constructor(
    readonly agentId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'AgentStartError';
  }
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
  private readonly launches = new Map<string, AbortController>();
  private readonly opening = new Map<string, Promise<AgentConnection>>();
  private readonly starting = new Map<string, Promise<HostSession>>();
  private readonly discarding = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;

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

  sessionId(agentId: string): string | undefined { return this.sessions.get(agentId)?.sessionId; }

  executionProblem(agentId: string): string | undefined {
    const profile = this.options.config.agents[agentId];
    return profile ? mediationProblem(profile, this.connections.get(agentId)?.info?.name) : `Unknown agent ${agentId}`;
  }

  async rotate(agentId: string): Promise<HostSession> {
    const previous = this.sessions.get(agentId);
    if (previous?.isBusy) throw new Error(`Cannot rotate active session for ${agentId}`);
    const connection = await this.connection(agentId);
    const model = this.currentModel(agentId);
    const session = await connection.newSession();
    if (model) await session.selectModel(model);
    if (previous) connection.releaseSession(previous.sessionId);
    this.sessions.set(agentId, session);
    this.options.transcript.append({ type: 'session', agentId, sessionId: session.sessionId, how: 'new' });
    return session;
  }

  /**
   * The model this agent is on: what its live session reports, or the model
   * its profile asks for while no session is open yet. An agent that names no
   * model anywhere is left for the caller to call by its own id.
   */
  currentModel(agentId: string): string | undefined {
    return this.sessions.get(agentId)?.currentModel() ?? this.options.config.agents[agentId]?.model;
  }

  /** The models an agent's live session says it can be set to. */
  models(agentId: string): readonly ModelChoice[] {
    return this.sessions.get(agentId)?.models() ?? [];
  }

  async connection(agentId: string): Promise<AgentConnection> {
    this.assertOpen();
    const existing = this.connections.get(agentId);
    if (existing) return existing;
    const pending = this.opening.get(agentId);
    if (pending) return pending;

    const attempt = this.open(agentId).finally(() => this.opening.delete(agentId));
    this.opening.set(agentId, attempt);
    return attempt;
  }

  /**
   * The one session handsfree keeps with this agent for the current run. Two
   * callers arriving while it is still opening wait on the same attempt:
   * `session/new` asked twice would answer twice, and the second session would
   * quietly replace the first while the first still held the run's context.
   */
  async session(agentId: string): Promise<HostSession> {
    this.assertOpen();
    const existing = this.sessions.get(agentId);
    if (existing && !existing.invalidated) return existing;
    if (existing) await this.discard(agentId);
    const pending = this.starting.get(agentId);
    if (pending) return pending;

    const attempt = this.start(agentId)
      .catch((err: unknown) => {
        const failure = new AgentStartError(agentId, err);
        this.options.transcript.append({ type: 'note', level: 'error', text: failure.message });
        throw failure;
      })
      .finally(() => this.starting.delete(agentId));
    this.starting.set(agentId, attempt);
    return attempt;
  }

  /** Opens the run's session with an agent, resuming the saved one if there is one. */
  private async start(agentId: string): Promise<HostSession> {
    const problem = this.executionProblem(agentId);
    if (problem) throw new Error(problem);
    const connection = await this.connection(agentId);
    const identified = this.executionProblem(agentId);
    if (identified) throw new Error(identified);
    const saved = this.options.workspace.readSessionIds()[agentId];
    const resumed = saved ? await connection.loadSession(saved) : undefined;
    const session = resumed ?? (await connection.newSession());
    this.assertOpen();
    this.options.transcript.append({
      type: 'session',
      agentId,
      sessionId: session.sessionId,
      how: resumed ? 'resumed' : 'new',
    });
    // A profile that asks for a model gets it before anything else touches the
    // session, a resumed one included — it comes back on whatever it was last
    // on. A profile that asks for none leaves the agent on its own default,
    // which is the CLI's, which is very likely the one you want.
    const model = this.options.config.agents[agentId]?.model;
    if (model !== undefined) await session.selectModel(model);
    this.sessions.set(agentId, session);
    return session;
  }

  /** Drops a wedged agent so the next request starts a fresh process. */
  async discard(agentId: string): Promise<void> {
    this.launches.get(agentId)?.abort();
    this.sessions.delete(agentId);
    const connection = this.connections.get(agentId);
    this.connections.delete(agentId);
    if (connection) {
      const closing = connection.close();
      this.discarding.add(closing);
      try { await closing; } finally { this.discarding.delete(closing); }
    }
  }

  closeAll(): Promise<void> {
    this.closed = true;
    for (const launch of this.launches.values()) launch.abort();
    return this.closing ??= this.closeConnections();
  }

  private async closeConnections(): Promise<void> {
    // Stop transports immediately, including initialize requests still in
    // flight, then drain the callers before the runtime ends its transcript.
    const pending = Promise.allSettled([...this.opening.values(), ...this.starting.values()]);
    const cleanup = await Promise.allSettled([
      ...[...this.connections.values()].map((connection) => connection.close()),
      ...this.discarding,
    ]);
    await pending;
    this.connections.clear();
    this.sessions.clear();
    const failure = cleanup.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Agent pool is closed.');
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

    const launch = new AbortController();
    this.launches.set(agentId, launch);
    try {
      const connection = await openAgent({ agentId, profile, host,
        signal: launch.signal, createTarget: this.options.createTarget });
      if (this.closed) {
        await connection.close();
        this.assertOpen();
      }
      this.connections.set(agentId, connection);
      return connection;
    } finally { this.launches.delete(agentId); }
  }
}
