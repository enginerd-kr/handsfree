import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentProfile } from '../config/schema.js';
import type { HostContext } from '../host/capabilities/context.js';
import { AgentConnection, type ConnectionTarget } from '../host/connection.js';
import { fallbackArgs, spawnTarget } from '../host/launch.js';
import { mediationProblem } from '../host/mediation.js';
import { SessionUnresponsiveError } from '../host/session.js';
import type { ChatClient, ChatMessage, ChatOptions, JsonSchemaSpec } from './client.js';

export interface AcpModelOptions {
  /** Which `agents` entry does the planning. Used in error messages. */
  agentId: string;
  profile: AgentProfile;
  /**
   * Context for the brain's own connection. Its transcript should be a quiet
   * one: planning chatter rendered into the main transcript would put every
   * routing JSON on the user's screen as if an agent had said it.
   */
  host: HostContext;
  /**
   * The model the planning sessions are put on, matched against the agent's
   * roster the way a `:model` mention is. Omitted, the agent stays on whatever
   * it opened on.
   */
  model?: string;
  /** Overridden by tests to connect an in-process agent instead of spawning one. */
  createTarget?: (agentId: string, profile: AgentProfile) => ConnectionTarget;
}

/**
 * A frontier model as the orchestration brain, reached the only way handsfree
 * reaches anything: over ACP. The agent runs in a connection of its own —
 * sharing the pool's session would collide with the very turn it is planning,
 * and would write planning chatter into that task's context.
 *
 * ChatClient is stateless per call while ACP sessions are not, so every chat
 * opens a fresh session and carries the rendered conversation with it. The
 * process underneath is reused; only the session is new.
 */
export class AcpModel implements ChatClient {
  private lifetime = new AbortController();
  private connecting: Promise<AgentConnection> | undefined;
  private openingTarget: ConnectionTarget | undefined;
  private readonly discarding = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: AcpModelOptions) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    options.signal?.throwIfAborted();
    const cancel = () => { void this.close(); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try { return await this.reply(messages, options); }
    finally { options.signal?.removeEventListener('abort', cancel); }
  }

  private async reply(messages: ChatMessage[], options: ChatOptions): Promise<string> {
    const problem = mediationProblem(this.options.profile);
    if (problem) throw new Error(problem);
    const connection = await this.connect();
    const identified = mediationProblem(this.options.profile, connection.info?.name);
    if (identified) throw new Error(identified);

    let reply = '';
    let session;
    try {
      session = await connection.newSession((update: SessionUpdate) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          reply += update.content.text;
          options.onDelta?.(update.content.text);
        }
      });
    } catch (err) {
      // A connection that cannot open sessions is dead; the next chat respawns.
      await this.discard(connection);
      throw err;
    }

    // The model is settled before the prompt goes out, and every session is a
    // new one, so each reply is planned on the model the config names. A name
    // the agent will not take fails the turn naming its roster — the
    // connection is fine, it is the name that is wrong, so it is not discarded.
    let stopReason;
    try {
      if (this.options.model !== undefined) await session.selectModel(this.options.model);
      const end = await session.prompt(render(messages, options.schema), {
        signal: options.signal,
      });
      stopReason = end.stopReason;
      // The agent's own count of the planning turn, in the shape every other
      // endpoint's arrives in. What was read from cache was still read, so it
      // goes on the prompt side: the figure is what the turn took, not what
      // it was billed.
      if (end.usage) {
        const { inputTokens, outputTokens, cachedReadTokens = 0, cachedWriteTokens = 0, thoughtTokens = 0 } = end.usage;
        options.onUsage?.({
          promptTokens: inputTokens + cachedReadTokens + cachedWriteTokens,
          completionTokens: outputTokens + thoughtTokens,
          cachedTokens: cachedReadTokens,
          cachedWriteTokens,
        });
      }
    } catch (err) {
      if (err instanceof SessionUnresponsiveError) await this.discard(connection);
      throw err;
    } finally {
      connection.releaseSession(session.sessionId);
    }

    options.signal?.throwIfAborted();
    if (reply.trim() === '') {
      throw new Error(`${this.options.agentId} ended the planning turn (${stopReason}) without replying`);
    }
    return reply;
  }

  close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    return this.closing ??= this.closeConnection();
  }

  private async closeConnection(): Promise<void> {
    const pending = this.connecting;
    const results = await Promise.allSettled([
      this.openingTarget?.close(),
      pending?.then((connection) => connection.close(), () => {}),
      ...this.discarding,
    ]);
    this.connecting = undefined;
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private connect(): Promise<AgentConnection> {
    this.assertOpen();
    if (this.connecting) return this.connecting;
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    const attempt = this.open().catch((err) => {
      // A failed launch must not poison every later turn.
      if (this.connecting === attempt) this.connecting = undefined;
      throw err;
    });
    this.connecting = attempt;
    return attempt;
  }

  private async open(): Promise<AgentConnection> {
    const { profile, host } = this.options;
    const attempts = [profile.args, fallbackArgs(profile.args)].filter(
      (args): args is string[] => args !== undefined,
    );

    let lastError: Error | undefined;
    for (const args of attempts) {
      this.lifetime.signal.throwIfAborted();
      const profileForAttempt = { ...profile, args };
      const target = this.options.createTarget
        ? this.options.createTarget(this.options.agentId, profileForAttempt)
        : spawnTarget(profileForAttempt, {
            cwd: host.workspace.dir,
            env: host.config.env,
            onStderr: (text) =>
              host.transcript.append({ type: 'agent_stderr', agentId: host.agentId, text }),
          });
      this.openingTarget = target;
      try {
        return await AgentConnection.open({ agentId: host.agentId, host, target, signal: this.lifetime.signal });
      } catch (err) {
        lastError = err as Error;
        await target.close();
      } finally {
        if (this.openingTarget === target) this.openingTarget = undefined;
      }
    }
    throw lastError ?? new Error(`Could not start ${this.options.agentId} for orchestration.`);
  }

  private async discard(connection: AgentConnection): Promise<void> {
    this.connecting = undefined;
    const closing = connection.close().catch(() => {});
    this.discarding.add(closing);
    try { await closing; } finally { this.discarding.delete(closing); }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ACP model is closed.');
  }
}

/**
 * The whole conversation in one prompt, because the session it lands in is
 * brand new. The instructions close the prompt rather than open it so the reply
 * format is the last thing the model reads before answering.
 */
function render(messages: ChatMessage[], schema?: JsonSchemaSpec): string {
  const conversation = messages.map((message) => `[${message.role}]\n${message.content}`);
  const instructions = [
    'You are the orchestration model in this conversation. Write the next [assistant] reply.',
    'Read the whole conversation first. The last [user] line follows from what came before it: a short line like "yes" or "응" answers the question the previous [assistant] reply asked, so do what that question was about instead of asking again.',
    'Reply with the message text only — no preamble, no commentary on these instructions.',
    'Do not use tools and do not read or change any files: the reply itself is your only output.',
  ];
  if (schema) {
    instructions.push(
      'The reply must be exactly one JSON object matching this JSON Schema, and nothing else:\n' +
        JSON.stringify(schema.schema),
    );
  }
  return `${conversation.join('\n\n')}\n\n[instructions]\n${instructions.join('\n')}`;
}
