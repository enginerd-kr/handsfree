import { Readable, Writable } from 'node:stream';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type AgentContext,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { Config } from '../config/schema.js';
import type { ConfigLocation } from '../config/load.js';
import { createRuntime, type Runtime, type RuntimeOptions } from '../runtime.js';
import type { Escalator } from '../policy/types.js';
import type { TranscriptRecord } from '../workspace/transcript.js';
import { VERSION } from '../version.js';

interface ServedSession {
  runtime: Runtime;
  forward: (record: TranscriptRecord) => void;
}

/**
 * handsfree from the other side: an ACP agent that an editor can drive. The
 * routing, the workspace boundary and the three gates are unchanged — the only
 * difference is who answers an escalated permission request. Here it is the
 * editor, which is exactly the human seat the design has always assumed.
 */
export interface ServeApp {
  app: AgentApp;
  /** Shuts every session started through this app down. */
  dispose(): Promise<void>;
}

export function createServeApp(config: Config, overrides: Partial<RuntimeOptions> = {}): ServeApp {
  const sessions = new Map<string, ServedSession>();
  let counter = 0;

  const app = agent({ name: 'handsfree' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'handsfree', title: 'handsfree', version: VERSION },
      agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, (ctx) => {
      const sessionId = `handsfree-${++counter}`;
      // The editor's project is both the jail and where its command files
      // live, which is the one arrangement where the two are the same.
      const runtime = createRuntime({
        config,
        attachTo: ctx.params.cwd,
        cwd: ctx.params.cwd,
        ...overrides,
      });
      runtime.setEscalator(upstreamEscalator(ctx.client, sessionId));

      const forward = (record: TranscriptRecord) => {
        const update = toUpdate(record);
        if (update) void ctx.client.notify(methods.client.session.update, { sessionId, update });
      };
      runtime.transcript.on('record', forward);
      sessions.set(sessionId, { runtime, forward });
      return { sessionId };
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const served = sessions.get(ctx.params.sessionId);
      if (!served) throw new Error(`unknown session ${ctx.params.sessionId}`);

      const text = ctx.params.prompt
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();

      const stop = () => served.runtime.conversation.cancel();
      ctx.signal.addEventListener('abort', stop, { once: true });
      try {
        await served.runtime.conversation.send(text);
      } finally {
        ctx.signal.removeEventListener('abort', stop);
      }
      return { stopReason: ctx.signal.aborted ? 'cancelled' : 'end_turn' };
    })
    .onNotification(methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.runtime.conversation.cancel();
    });

  return {
    app,
    async dispose() {
      for (const served of sessions.values()) {
        served.runtime.transcript.off('record', served.forward);
        await served.runtime.close();
      }
      sessions.clear();
    },
  };
}

export async function serve(
  config: Config,
  configSources: readonly ConfigLocation[] = [],
): Promise<number> {
  const served = createServeApp(config, { configSources });
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = served.app.connect(stream);
  await connection.closed;
  await served.dispose();
  return 0;
}

/**
 * Escalation travels up the chain: handsfree could not decide, so it asks the
 * client driving it. The answer is still applied by our policy engine, and it is
 * still recorded as ours.
 */
function upstreamEscalator(client: AgentContext, sessionId: string): Escalator {
  return {
    async ask(question) {
      const response = await client.request<RequestPermissionResponse>(
        methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: {
            toolCallId: `ask-${question.rule}-${Date.now()}`,
            title: `${question.context.agentId}: ${question.summary}`,
            kind: 'other',
            rawInput: { rule: question.rule, detail: question.detail },
          },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Refuse', kind: 'reject_once' },
          ],
        },
      );
      return response.outcome.outcome === 'selected' && response.outcome.optionId === 'allow';
    },
  };
}

/** Our transcript, re-expressed in the vocabulary the editor already renders. */
function toUpdate(record: TranscriptRecord) {
  switch (record.type) {
    case 'assistant':
      // A streamed reply arrives as deltas and closes with the full text here;
      // forwarding only the close keeps the editor from seeing it twice. An
      // empty text is a retraction, and there is nothing to unsay upstream.
      return record.text === ''
        ? undefined
        : {
            sessionUpdate: 'agent_message_chunk' as const,
            content: { type: 'text' as const, text: record.text },
          };
    case 'delegation':
      return {
        sessionUpdate: 'tool_call' as const,
        toolCallId: `task-${record.taskId}`,
        title: `${record.agentId}: ${record.task}`,
        kind: 'other' as const,
        status: 'in_progress' as const,
      };
    case 'stop':
      return {
        sessionUpdate: 'tool_call_update' as const,
        toolCallId: `task-${record.taskId}`,
        status: record.stopReason === 'end_turn' ? ('completed' as const) : ('failed' as const),
      };
    case 'decision':
      return record.entry.verdict === 'deny'
        ? {
            sessionUpdate: 'agent_thought_chunk' as const,
            content: {
              type: 'text' as const,
              text: `refused ${record.entry.summary}: ${record.entry.reason ?? record.entry.rule}`,
            },
          }
        : undefined;
    case 'session_update':
      // Sub-agent file operations are worth showing; its prose is not — that is
      // what the summary is for.
      return record.update.sessionUpdate === 'tool_call' ||
        record.update.sessionUpdate === 'tool_call_update'
        ? { ...record.update, toolCallId: `${record.agentId}:${record.update.toolCallId}` }
        : undefined;
    default:
      return undefined;
  }
}
