import {
  client,
  methods,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type ClientApp,
  type ClientConnection,
  type Implementation,
  type PromptRequest,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { HostContext } from '../capabilities/context.js';
import { createFsHandlers } from '../capabilities/fs.js';
import { createPermissionHandler } from '../capabilities/permission.js';
import { TerminalRegistry } from '../capabilities/terminal.js';
import { VERSION } from '../version.js';
import { HostSession } from './session.js';

export interface ConnectionTarget {
  /** Attaches the built client app to whatever carries the protocol. */
  connect(app: ClientApp): ClientConnection;
  /** Tears the transport down. */
  close(): Promise<void>;
  description: string;
  /**
   * Resolves with the reason the transport died. A process that fails to start
   * would otherwise leave the first request hanging until its own timeout.
   */
  broken?: Promise<Error>;
  /** Recent adapter output, used to explain an otherwise opaque failure. */
  diagnostics?(): string;
}

export interface OpenOptions {
  agentId: string;
  host: HostContext;
  target: ConnectionTarget;
}

export class AuthenticationRequiredError extends Error {
  constructor(
    readonly agentId: string,
    readonly methods: readonly AuthMethod[],
    cause: string,
  ) {
    super(
      `${agentId} needs to be logged in before handsfree can use it (${cause}). ` +
        (methods.length > 0
          ? `It offers: ${methods.map((m) => m.name || m.id).join(', ')}. `
          : '') +
        'Authenticate with the agent’s own CLI, then try again.',
    );
    this.name = 'AuthenticationRequiredError';
  }
}

const CLIENT_INFO: Implementation = {
  name: 'handsfree',
  title: 'handsfree',
  version: VERSION,
};

/**
 * One live agent. The capabilities handsfree declares here are exactly the ones
 * it implements, because a declared capability is a promise the agent is
 * entitled to rely on — and an undeclared one sends the agent back to its own
 * tools, where we would see the permission request but not the operation.
 */
export class AgentConnection {
  private closed = false;

  private constructor(
    readonly agentId: string,
    readonly info: Implementation | null,
    readonly capabilities: AgentCapabilities,
    readonly authMethods: readonly AuthMethod[],
    private readonly sessions: Map<string, HostSession>,
    private readonly connection: ClientConnection,
    private readonly target: ConnectionTarget,
    private readonly host: HostContext,
    private readonly terminals: TerminalRegistry | undefined,
  ) {}

  static async open({ agentId, host, target }: OpenOptions): Promise<AgentConnection> {
    const caps = host.config.capabilities;
    const sessions = new Map<string, HostSession>();
    const permission = createPermissionHandler(host);
    const files = createFsHandlers(host);
    const terminals = caps.terminal ? new TerminalRegistry(host) : undefined;

    const app: ClientApp = client({ name: 'handsfree' })
      .onRequest(methods.client.session.requestPermission, (ctx) => permission(ctx.params))
      .onNotification(methods.client.session.update, (ctx) => {
        route(sessions, host, agentId, ctx.params);
      });

    if (caps.readTextFile) {
      app.onRequest(methods.client.fs.readTextFile, (ctx) => files.readTextFile(ctx.params));
    }
    if (caps.writeTextFile) {
      app.onRequest(methods.client.fs.writeTextFile, (ctx) => files.writeTextFile(ctx.params));
    }
    if (terminals) {
      const handlers = terminals.handlers();
      app
        .onRequest(methods.client.terminal.create, (ctx) => handlers.create(ctx.params))
        .onRequest(methods.client.terminal.output, (ctx) => handlers.output(ctx.params))
        .onRequest(methods.client.terminal.waitForExit, (ctx) => handlers.waitForExit(ctx.params))
        .onRequest(methods.client.terminal.kill, (ctx) => handlers.kill(ctx.params))
        .onRequest(methods.client.terminal.release, (ctx) => handlers.release(ctx.params));
    }

    const connection = target.connect(app);
    let initialized;
    try {
      initialized = await orBroken(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: CLIENT_INFO,
          clientCapabilities: {
            fs: { readTextFile: caps.readTextFile, writeTextFile: caps.writeTextFile },
            terminal: caps.terminal,
          },
        }),
        target.broken,
        host.config.limits.handshakeTimeoutMs,
        `${agentId} did not answer initialize`,
      );
    } catch (err) {
      connection.close();
      await target.close();
      throw new Error(`${agentId} failed to initialize over ACP: ${(err as Error).message}`);
    }

    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      host.transcript.append({
        type: 'note',
        level: 'warn',
        text:
          `${agentId} speaks ACP v${initialized.protocolVersion}, handsfree speaks ` +
          `v${PROTOCOL_VERSION}; continuing, but capabilities may not line up.`,
      });
    }

    return new AgentConnection(
      agentId,
      initialized.agentInfo ?? null,
      initialized.agentCapabilities ?? {},
      initialized.authMethods ?? [],
      sessions,
      connection,
      target,
      host,
      terminals,
    );
  }

  get description(): string {
    const name = this.info?.name ?? this.agentId;
    return this.info?.version ? `${name} ${this.info.version}` : name;
  }

  async newSession(): Promise<HostSession> {
    let response;
    try {
      response = await this.connection.agent.request(methods.agent.session.new, {
        cwd: this.host.workspace.dir,
        mcpServers: [],
      });
    } catch (err) {
      throw this.explain(err);
    }
    const session = this.register(response.sessionId);
    this.host.workspace.writeSessionId(this.agentId, response.sessionId);
    return session;
  }

  /**
   * Rejoins a session from an earlier run. The agent replays the conversation as
   * `session/update` notifications before this resolves, which is also how the
   * transcript gets rebuilt.
   */
  async loadSession(sessionId: string): Promise<HostSession | undefined> {
    if (this.capabilities.loadSession !== true) return undefined;
    const session = this.register(sessionId);
    try {
      await this.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: this.host.workspace.dir,
        mcpServers: [],
      });
      return session;
    } catch {
      this.sessions.delete(sessionId);
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.terminals?.disposeAll();
    try {
      this.connection.close();
    } catch {
      // Already down.
    }
    await this.target.close();
  }

  private register(sessionId: string): HostSession {
    const session = new HostSession(
      this.agentId,
      sessionId,
      {
        prompt: (request: PromptRequest, signal: AbortSignal) =>
          this.connection.agent
            .request(methods.agent.session.prompt, request, { cancellationSignal: signal })
            // The reason a turn failed — a retired model, a quota, a missing
            // login — arrives in `data.details` behind a generic message.
            .catch((err: unknown) => {
              throw this.explain(err);
            }),
        cancel: (id: string) =>
          this.connection.agent.notify(methods.agent.session.cancel, { sessionId: id }),
      },
      () => {},
    );
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Turns an adapter's error into something a person can act on. Adapters
   * routinely answer with a bare "Internal error" while having written the real
   * reason to stderr, so both are put in front of the user.
   */
  private explain(err: unknown): Error {
    const error = err as { code?: number; message?: string; data?: unknown };
    const message = error.message ?? String(err);
    const details = (error.data as { details?: string } | undefined)?.details;
    const stderr = this.target.diagnostics?.();

    if (error.code === -32000 || /auth/i.test(message)) {
      if (this.authMethods.length > 0 || /auth/i.test(message)) {
        return new AuthenticationRequiredError(this.agentId, this.authMethods, message);
      }
    }
    const parts = [`${this.agentId}: ${message}`];
    if (details) parts.push(details);
    if (stderr) parts.push(stderr);
    return new Error(parts.join(' — '));
  }
}

/**
 * The handshake is the one exchange with no protocol-level timeout behind it: if
 * an adapter starts but never answers, nothing else will ever notice.
 */
function orBroken<T>(
  work: Promise<T>,
  broken: Promise<Error> | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${timeoutMessage} within ${timeoutMs}ms`)), timeoutMs);
  });
  const races: Promise<T>[] = [work, deadline];
  if (broken) {
    races.push(
      broken.then((error) => {
        throw error;
      }),
    );
  }
  return Promise.race(races).finally(() => clearTimeout(timer));
}

/**
 * Every update is written to the transcript before anything interprets it, so
 * what the UI shows and what the narrator later reads are the same record.
 */
function route(
  sessions: Map<string, HostSession>,
  host: HostContext,
  agentId: string,
  notification: SessionNotification,
): void {
  host.transcript.append({
    type: 'session_update',
    agentId,
    sessionId: notification.sessionId,
    update: notification.update,
  });
  sessions.get(notification.sessionId)?.receive(notification.update);
}
