import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentProfile } from '../config/schema.js';
import type { HostContext } from '../capabilities/context.js';
import { AgentConnection, type ConnectionTarget } from '../host/connection.js';
import { fallbackArgs, spawnTarget } from '../host/launch.js';
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
  /** Wall clock for a single reply. */
  timeoutMs: number;
  cancelGraceMs: number;
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
  private connecting: Promise<AgentConnection> | undefined;

  constructor(private readonly options: AcpModelOptions) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const connection = await this.connect();

    let reply = '';
    let session;
    try {
      session = await connection.newSession((update: SessionUpdate) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          reply += update.content.text;
        }
      });
    } catch (err) {
      // A connection that cannot open sessions is dead; the next chat respawns.
      await this.discard(connection);
      throw err;
    }

    let stopReason;
    try {
      stopReason = await session.prompt(render(messages, options.schema), {
        turnTimeoutMs: this.options.timeoutMs,
        idleTimeoutMs: this.options.timeoutMs,
        cancelGraceMs: this.options.cancelGraceMs,
        signal: options.signal,
      });
    } catch (err) {
      if (err instanceof SessionUnresponsiveError) await this.discard(connection);
      throw err;
    }

    if (reply.trim() === '') {
      throw new Error(`${this.options.agentId} ended the planning turn (${stopReason}) without replying`);
    }
    return reply;
  }

  async close(): Promise<void> {
    const pending = this.connecting;
    this.connecting = undefined;
    const connection = await pending?.catch(() => undefined);
    await connection?.close();
  }

  private connect(): Promise<AgentConnection> {
    if (this.connecting) return this.connecting;
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
      const profileForAttempt = { ...profile, args };
      const target = this.options.createTarget
        ? this.options.createTarget(this.options.agentId, profileForAttempt)
        : spawnTarget(profileForAttempt, {
            cwd: host.workspace.dir,
            proxy: host.config.proxy,
            onStderr: (text) =>
              host.transcript.append({ type: 'agent_stderr', agentId: host.agentId, text }),
          });
      try {
        return await AgentConnection.open({ agentId: host.agentId, host, target });
      } catch (err) {
        lastError = err as Error;
        await target.close();
      }
    }
    throw lastError ?? new Error(`Could not start ${this.options.agentId} for orchestration.`);
  }

  private async discard(connection: AgentConnection): Promise<void> {
    this.connecting = undefined;
    await connection.close().catch(() => {});
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
