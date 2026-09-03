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
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { HostContext } from '../capabilities/context.js';
import { debug } from '../debug.js';
import { createElicitationHandler } from '../capabilities/elicit.js';
import { createFsHandlers } from '../capabilities/fs.js';
import { createPermissionHandler } from '../capabilities/permission.js';
import { TerminalRegistry } from '../capabilities/terminal.js';
import { VERSION } from '../version.js';
import { HostSession, modelStateOf } from './session.js';

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
        // A logged-in CLI is not the same as a logged-in adapter: gemini reads
        // `~/.gemini/.env` when you run it yourself and not when it speaks ACP,
        // so a key that works in the terminal still has to reach this process.
        'Authenticate with the agent’s own CLI — and where that login is an API ' +
        'key, make sure the variable holding it is in handsfree’s own environment ' +
        '(or the agent profile’s `env`), since agents are spawned directly and ' +
        'never read your shell.',
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
    const elicit = caps.elicitation ? createElicitationHandler(host) : undefined;
    const terminals = caps.terminal ? new TerminalRegistry(host) : undefined;

    // Every handler is given the request's own signal. A question put to a
    // person outlives nothing: when the agent withdraws the request the
    // question comes down with it, rather than waiting out its deadline and
    // answering into a request that is no longer there.
    const app: ClientApp = client({ name: 'handsfree' })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        permission(ctx.params, ctx.signal),
      )
      .onNotification(methods.client.session.update, (ctx) => {
        route(sessions, host, agentId, ctx.params);
      });

    if (caps.readTextFile) {
      app.onRequest(methods.client.fs.readTextFile, (ctx) =>
        files.readTextFile(ctx.params, ctx.signal),
      );
    }
    if (caps.writeTextFile) {
      app.onRequest(methods.client.fs.writeTextFile, (ctx) =>
        files.writeTextFile(ctx.params, ctx.signal),
      );
    }
    if (elicit) {
      app.onRequest(methods.client.elicitation.create, (ctx) => elicit(ctx.params, ctx.signal));
    }
    if (terminals) {
      const handlers = terminals.handlers();
      app
        .onRequest(methods.client.terminal.create, (ctx) => handlers.create(ctx.params, ctx.signal))
        .onRequest(methods.client.terminal.output, (ctx) => handlers.output(ctx.params))
        .onRequest(methods.client.terminal.waitForExit, (ctx) => handlers.waitForExit(ctx.params))
        .onRequest(methods.client.terminal.kill, (ctx) => handlers.kill(ctx.params))
        .onRequest(methods.client.terminal.release, (ctx) => handlers.release(ctx.params));
    }

    const connection = target.connect(app);
    debug(agentId, `initialize → ${target.description} (timeout ${host.config.limits.handshakeTimeoutMs}ms)`);
    const started = Date.now();
    let initialized;
    try {
      initialized = await orBroken(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: CLIENT_INFO,
          clientCapabilities: {
            fs: { readTextFile: caps.readTextFile, writeTextFile: caps.writeTextFile },
            terminal: caps.terminal,
            // Form only. A URL question would send the user somewhere handsfree
            // cannot follow, and a capability we cannot honour is one we do not
            // claim — an agent that knows it can ask is an agent that stops
            // guessing when it should be asking.
            ...(caps.elicitation ? { elicitation: { form: {} } } : {}),
          },
        }),
        target.broken,
        host.config.limits.handshakeTimeoutMs,
        `${agentId} did not answer initialize`,
      );
    } catch (err) {
      debug(agentId, `initialize failed after ${Date.now() - started}ms: ${(err as Error).message}`);
      const stderr = target.diagnostics?.();
      if (stderr) debug(agentId, `recent adapter stderr: ${stderr}`);
      connection.close();
      await target.close();
      throw new Error(`${agentId} failed to initialize over ACP: ${(err as Error).message}`);
    }

    const info = initialized.agentInfo;
    debug(
      agentId,
      `initialize ok in ${Date.now() - started}ms: ` +
        `${info ? `${info.name} ${info.version ?? ''}`.trim() : 'unnamed agent'}, ` +
        `protocol v${initialized.protocolVersion}, ` +
        `auth: ${(initialized.authMethods ?? []).map((m) => m.name || m.id).join(', ') || 'none advertised'}`,
    );

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

  /** `onUpdate` sees every `session/update` for the new session, live. */
  async newSession(onUpdate?: (update: SessionUpdate) => void): Promise<HostSession> {
    let response;
    try {
      response = await this.connection.agent.request(methods.agent.session.new, {
        cwd: this.host.workspace.dir,
        mcpServers: [],
      });
    } catch (err) {
      throw this.explain(err);
    }
    const session = this.register(response.sessionId, onUpdate);
    session.adoptModelState(modelStateOf(response));
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
    // What the agent replays while loading is the conversation this run
    // already has on file — the transcript was read back before the agent
    // was even started — so it is heard, for the model state it carries, and
    // not written down a second time.
    session.replaying = true;
    try {
      const response = await this.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd: this.host.workspace.dir,
        mcpServers: [],
      });
      session.adoptModelState(modelStateOf(response));
      // The answer is not the end of the replay for every agent; the quiet
      // after it is.
      await session.untilQuiet(REPLAY_GAP_MS, REPLAY_CAP_MS);
      return session;
    } catch {
      this.sessions.delete(sessionId);
      return undefined;
    } finally {
      session.replaying = false;
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

  private register(
    sessionId: string,
    onUpdate: (update: SessionUpdate) => void = () => {},
  ): HostSession {
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
        setConfigOption: async (request) => {
          await this.connection.agent
            .request(methods.agent.session.setConfigOption, request)
            .catch((err: unknown) => {
              throw this.explain(err);
            });
        },
        setModel: async (request) => {
          // Spelled out because the current SDK dropped the draft method from
          // its tables; the adapters still on it answer the string all the same.
          await this.connection.agent
            .request<void, { sessionId: string; modelId: string }>('session/set_model', request)
            .catch((err: unknown) => {
              throw this.explain(err);
            });
        },
      },
      onUpdate,
      () => this.host.policy.isWaiting(this.agentId),
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
    debug(
      this.agentId,
      `agent error${error.code !== undefined ? ` (code ${error.code})` : ''}: ${message}` +
        (details ? ` — ${details}` : ''),
    );

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

/** How long a loaded session has to be silent before its replay is taken as over. */
const REPLAY_GAP_MS = 200;
/** How long to wait for that silence at most, for an agent that keeps talking. */
const REPLAY_CAP_MS = 2_000;

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
  const session = sessions.get(notification.sessionId);
  if (!session?.replaying) {
    host.transcript.append({
      type: 'session_update',
      agentId,
      sessionId: notification.sessionId,
      update: notification.update,
    });
  }
  session?.receive(notification.update);
}
