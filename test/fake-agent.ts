import {
  agent,
  methods,
  PROTOCOL_VERSION,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionResponse,
  type StopReason,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import type { ClientApp, ClientConnection } from '@agentclientprotocol/sdk';
import type { ConnectionTarget } from '../src/host/connection.js';

/**
 * A scripted ACP agent. Every test that involves an agent uses this rather than
 * a real CLI: the interesting cases — a refused command, a path outside the
 * workspace, a turn that never ends — are all things a real adapter will not do
 * on demand.
 */
export type Act =
  | { do: 'say'; text: string }
  | { do: 'think'; text: string }
  | {
      do: 'ask';
      title: string;
      kind: ToolKind;
      locations?: string[];
      rawInput?: unknown;
      /** Defaults to the usual three-option set. */
      options?: PermissionOption[];
      /** Recorded so tests can assert on what the host answered. */
      onAnswer?: (optionId: string | 'cancelled') => void;
    }
  | { do: 'read'; path: string; onResult: (result: { ok: boolean; detail: string }) => void }
  | { do: 'write'; path: string; content: string; onResult: (result: { ok: boolean; detail: string }) => void }
  | {
      do: 'exec';
      command: string;
      args?: string[];
      onResult: (result: { ok: boolean; detail: string; output?: string }) => void;
    }
  | { do: 'tool'; toolCallId: string; title: string; kind: ToolKind; locations?: string[] }
  | { do: 'stall'; ms: number }
  | { do: 'stop'; reason: StopReason };

export interface FakeAgentOptions {
  name?: string;
  version?: string;
  loadSession?: boolean;
  /** Called for each prompt turn; returns what the agent should do. */
  script: (prompt: ContentBlock[], turn: number) => Act[];
}

export interface FakeAgent {
  app: AgentApp;
  target(): ConnectionTarget;
  /** Prompts received, in order. */
  prompts: string[];
}

const DEFAULT_OPTIONS: PermissionOption[] = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

export function fakeAgent(options: FakeAgentOptions): FakeAgent {
  const prompts: string[] = [];
  let turn = 0;
  let sessionCounter = 0;

  const app = agent({ name: options.name ?? 'fake-agent' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: options.name ?? 'fake-agent', version: options.version ?? '1.0.0' },
      agentCapabilities: {
        loadSession: options.loadSession ?? false,
        promptCapabilities: { embeddedContext: true },
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: `fake-${++sessionCounter}` }))
    .onRequest(methods.agent.session.load, () => ({}))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt
        .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
        .join('');
      prompts.push(text);
      const acts = options.script(ctx.params.prompt, turn++);
      return { stopReason: await perform(ctx.client, ctx.params.sessionId, acts, ctx.signal) };
    })
    .onNotification(methods.agent.session.cancel, () => {
      // The stall act watches the request signal, which the SDK aborts for us.
    });

  return {
    app,
    prompts,
    target(): ConnectionTarget {
      return {
        description: 'fake agent (in process)',
        connect: (clientApp: ClientApp): ClientConnection => clientApp.connect(app),
        close: async () => {},
      };
    },
  };
}

async function perform(
  client: AgentContext,
  sessionId: string,
  acts: Act[],
  signal: AbortSignal,
): Promise<StopReason> {
  for (const act of acts) {
    if (signal.aborted) return 'cancelled';

    switch (act.do) {
      case 'say':
        await client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: act.text },
          },
        });
        break;

      case 'think':
        await client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: act.text },
          },
        });
        break;

      case 'tool':
        await client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: act.toolCallId,
            title: act.title,
            kind: act.kind,
            status: 'completed',
            locations: (act.locations ?? []).map((path) => ({ path })),
          },
        });
        break;

      case 'ask': {
        const response = await client.request<RequestPermissionResponse>(
          methods.client.session.requestPermission,
          {
            sessionId,
            toolCall: {
              toolCallId: `call-${act.title}`,
              title: act.title,
              kind: act.kind,
              locations: (act.locations ?? []).map((path) => ({ path })),
              rawInput: act.rawInput ?? null,
            },
            options: act.options ?? DEFAULT_OPTIONS,
          },
        );
        act.onAnswer?.(
          response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled',
        );
        break;
      }

      case 'read':
        try {
          const result = await client.request(methods.client.fs.readTextFile, {
            sessionId,
            path: act.path,
          });
          act.onResult({ ok: true, detail: result.content });
        } catch (err) {
          act.onResult({ ok: false, detail: (err as Error).message });
        }
        break;

      case 'write':
        try {
          await client.request(methods.client.fs.writeTextFile, {
            sessionId,
            path: act.path,
            content: act.content,
          });
          act.onResult({ ok: true, detail: 'written' });
        } catch (err) {
          act.onResult({ ok: false, detail: (err as Error).message });
        }
        break;

      case 'exec':
        try {
          const created = await client.request(methods.client.terminal.create, {
            sessionId,
            command: act.command,
            args: act.args ?? [],
          });
          await client.request(methods.client.terminal.waitForExit, {
            sessionId,
            terminalId: created.terminalId,
          });
          const output = await client.request(methods.client.terminal.output, {
            sessionId,
            terminalId: created.terminalId,
          });
          await client.request(methods.client.terminal.release, {
            sessionId,
            terminalId: created.terminalId,
          });
          act.onResult({ ok: true, detail: 'ran', output: output.output });
        } catch (err) {
          act.onResult({ ok: false, detail: (err as Error).message });
        }
        break;

      case 'stall':
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, act.ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        break;

      case 'stop':
        return act.reason;
    }
  }
  return signal.aborted ? 'cancelled' : 'end_turn';
}
