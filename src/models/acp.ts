import { performance } from 'node:perf_hooks';
import { debug } from '../debug.js';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentProfile } from '../config/schema.js';
import type { HostContext } from '../host/capabilities/context.js';
import type { AgentConnection, ConnectionTarget } from '../host/connection.js';
import { openAgent } from '../host/open.js';
import { SessionUnresponsiveError } from '../host/session.js';
import type { ChatClient, ChatMessage, ChatOptions, JsonSchemaSpec } from './client.js';
import { modelFinish, ModelError } from './completion.js';

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
  private readonly discarding = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private resetting: Promise<void> | undefined;

  constructor(private readonly options: AcpModelOptions) {}

  prepare(): void {
    if (this.closed) return;
    void this.connect().then((connection) => connection.prepareSession(this.options.model)).catch(() => {});
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    await this.resetting;
    options.signal?.throwIfAborted();
    const cancel = () => { void this.reset(); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    try { return await this.reply(messages, options); }
    finally { options.signal?.removeEventListener('abort', cancel); }
  }

  private async reply(messages: ChatMessage[], options: ChatOptions): Promise<string> {
    const started = performance.now();
    const connection = await this.connect();

    let reply = '';
    let session;
    try {
      session = await connection.takePreparedSession();
    } catch (err) {
      // A connection that cannot open sessions is dead; the next chat respawns.
      await this.discard(connection);
      throw err;
    }

    // The model is settled before the prompt goes out, and every session is a
    // new one, so each reply is planned on the model the config names. A name
    // the agent will not take fails the turn naming its roster — the
    // connection is fine, it is the name that is wrong, so it is not discarded.
    const sessionMs = performance.now() - started;
    let firstUpdateMs: number | undefined;
    let firstOutputMs: number | undefined;
    let promptAt = performance.now();
    let prompting = false;
    const unsubscribe = session.subscribe((update: SessionUpdate) => {
      if (!prompting) return;
      firstUpdateMs ??= performance.now() - promptAt;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        if (update.content.text) firstOutputMs ??= performance.now() - promptAt;
        reply += update.content.text;
        options.onDelta?.(update.content.text);
      }
    });
    let stopReason;
    try {
      if (this.options.model !== undefined) await session.selectModel(this.options.model);
      const prompt = render(messages, options.schema);
      promptAt = performance.now();
      prompting = true;
      const pending = session.prompt(prompt, { signal: options.signal });
      // Submit the active prompt first; prepare the next empty session during generation.
      connection.prepareSession(this.options.model);
      const end = await pending;
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
      unsubscribe();
      const timing = { type: 'timing' as const, scope: 'planner' as const, agentId: this.options.agentId,
        queueMs: 0, sessionMs, prepareMs: promptAt - started - sessionMs,
        promptMs: performance.now() - promptAt, totalMs: performance.now() - started,
        ...(firstUpdateMs === undefined ? {} : { firstUpdateMs }), ...(firstOutputMs === undefined ? {} : { firstOutputMs }) };
      this.options.host.transcript.append(timing);
      debug('latency', JSON.stringify(timing));
      connection.releaseSession(session.sessionId);
    }

    options.signal?.throwIfAborted();
    options.onFinish?.(modelFinish(stopReason));
    if (reply.trim() === '') {
      const finish = modelFinish(stopReason);
      throw new ModelError(finish === 'refused' ? 'refused' : finish === 'truncated' ? 'truncated' : 'format',
        `${this.options.agentId} ended the planning turn (${stopReason}) without replying`);
    }
    return reply;
  }

  private reset(): Promise<void> {
    this.lifetime.abort();
    return this.resetting ??= this.closeConnection().finally(() => { this.resetting = undefined; });
  }

  close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    return this.closing ??= this.closeConnection();
  }

  private async closeConnection(): Promise<void> {
    const pending = this.connecting;
    const results = await Promise.allSettled([
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
    const attempt = openAgent({ ...this.options, signal: this.lifetime.signal }).catch((err) => {
      // A failed launch must not poison every later turn.
      if (this.connecting === attempt) this.connecting = undefined;
      throw err;
    });
    this.connecting = attempt;
    return attempt;
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
