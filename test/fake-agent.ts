import {
  agent,
  methods,
  PROTOCOL_VERSION,
  type AgentApp,
  type AgentContext,
  type ClientCapabilities,
  type ContentBlock,
  type CreateElicitationResponse,
  type ElicitationSchema,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionResponse,
  type StopReason,
  type ToolKind,
  type Usage,
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
      /** Omitted on purpose by some adapters — claude-code-acp sends no kind. */
      kind?: ToolKind;
      locations?: string[];
      rawInput?: unknown;
      /** Defaults to the usual three-option set. */
      options?: PermissionOption[];
      /** Recorded so tests can assert on what the host answered. */
      onAnswer?: (optionId: string | 'cancelled') => void;
    }
  | {
      do: 'elicit';
      message: string;
      /** The form the agent wants filled, as it would put it on the wire. */
      schema?: ElicitationSchema;
      /** Anything but `form` is a mode handsfree never advertised. */
      mode?: string;
      url?: string;
      onAnswer: (response: CreateElicitationResponse) => void;
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
  /**
   * The turn fails outright rather than ending. What a dying adapter looks
   * like from the host's side: the prompt request rejects, so the host never
   * learns whether the prompt was read before the process went.
   */
  | { do: 'fail'; message: string }
  /**
   * `usage` is the count the spec'd (unstable) field carries, as claude and
   * codex send it; `meta` is the raw `_meta`, for gemini's spelling of it.
   */
  | { do: 'stop'; reason: StopReason; usage?: Usage; meta?: Record<string, unknown> };

export interface FakeAgentOptions {
  name?: string;
  version?: string;
  loadSession?: boolean;
  /** What the agent replays, as message chunks, while a `session/load` is in flight. */
  replay?: string[];
  /**
   * Replay the way gemini does: answer the load first, then send the chunks
   * a few milliseconds later, one at a time.
   */
  replayLate?: boolean;
  /**
   * Advertise a model selector offering these, the first one current. This is
   * the roster the host reads: which models exist, and which one the session
   * came up on. A switch to an id not on it is refused, as a real adapter
   * refuses it.
   */
  models?: string[];
  /**
   * How the selector is spoken: the spec'd config option (default), or the
   * draft `models` + `session/set_model` dialect claude-code-acp still uses.
   */
  modelWire?: 'config_option' | 'set_model';
  /** Called for each prompt turn; returns what the agent should do. */
  script: (prompt: ContentBlock[], turn: number) => Act[];
}

export interface FakeAgent {
  app: AgentApp;
  target(): ConnectionTarget;
  /** Prompts received, in order. */
  prompts: string[];
  /** Every model the host set, over either wire, in order. */
  modelSets: string[];
  /** What the host said it could do, as it said it at `initialize`. */
  seen(): ClientCapabilities | undefined;
}

const DEFAULT_OPTIONS: PermissionOption[] = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];

export function fakeAgent(options: FakeAgentOptions): FakeAgent {
  const prompts: string[] = [];
  const modelSets: string[] = [];
  let turn = 0;
  let sessionCounter = 0;
  let seen: ClientCapabilities | undefined;

  const wire = options.modelWire ?? 'config_option';
  const roster = options.models ?? [];
  let currentModel = roster[0];
  const configOptions = () =>
    options.models === undefined || wire !== 'config_option'
      ? undefined
      : [
          {
            id: 'model',
            name: 'Model',
            category: 'model' as const,
            type: 'select' as const,
            currentValue: currentModel!,
            options: roster.map((id) => ({ value: id, name: id })),
          },
        ];
  const modelState = () =>
    options.models === undefined || wire !== 'set_model'
      ? undefined
      : {
          availableModels: roster.map((id) => ({ modelId: id, name: id })),
          currentModelId: currentModel!,
        };
  /** What a `session/new` or `session/load` answer carries about models. */
  const advertised = () => {
    const advertisedOptions = configOptions();
    const advertisedModels = modelState();
    return {
      ...(advertisedOptions === undefined ? {} : { configOptions: advertisedOptions }),
      // The draft field, off-schema on purpose — real adapters still send it.
      ...(advertisedModels === undefined ? {} : ({ models: advertisedModels } as object)),
    };
  };

  const app = agent({ name: options.name ?? 'fake-agent' })
    .onRequest(methods.agent.initialize, (ctx) => {
      seen = ctx.params.clientCapabilities;
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: options.name ?? 'fake-agent', version: options.version ?? '1.0.0' },
        agentCapabilities: {
          loadSession: options.loadSession ?? false,
          promptCapabilities: { embeddedContext: true },
        },
        authMethods: [],
      };
    })
    .onRequest(methods.agent.session.new, () => ({
      sessionId: `fake-${++sessionCounter}`,
      ...advertised(),
    }))
    .onRequest(methods.agent.session.load, async (ctx) => {
      const chunk = (text: string) =>
        ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        });
      if (options.replayLate) {
        // Spread over ~60ms, all of it after the answer below has gone out.
        (options.replay ?? []).forEach((text, at) => {
          setTimeout(() => void chunk(text), 5 + at * 20);
        });
        return advertised();
      }
      for (const text of options.replay ?? []) await chunk(text);
      return advertised();
    })
    .onRequest(methods.agent.session.setConfigOption, (ctx) => {
      const value = String(ctx.params.value);
      if (ctx.params.configId !== 'model' || !roster.includes(value)) {
        throw new Error(`cannot set ${ctx.params.configId} to ${value}`);
      }
      currentModel = value;
      modelSets.push(value);
      return { configOptions: configOptions()! };
    })
    .onRequest(
      'session/set_model',
      (params) => params as { sessionId: string; modelId: string },
      (ctx) => {
        if (wire !== 'set_model' || !roster.includes(ctx.params.modelId)) {
          throw new Error(`cannot set model to ${ctx.params.modelId}`);
        }
        currentModel = ctx.params.modelId;
        modelSets.push(ctx.params.modelId);
        return {};
      },
    )
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt
        .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
        .join('');
      prompts.push(text);
      const acts = options.script(ctx.params.prompt, turn++);
      return perform(ctx.client, ctx.params.sessionId, acts, ctx.signal);
    })
    .onNotification(methods.agent.session.cancel, () => {
      // The stall act watches the request signal, which the SDK aborts for us.
    });

  return {
    app,
    prompts,
    modelSets,
    seen: () => seen,
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
): Promise<PromptResponse> {
  for (const act of acts) {
    if (signal.aborted) return { stopReason: 'cancelled' };

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
              ...(act.kind ? { kind: act.kind } : {}),
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

      case 'elicit': {
        const mode = act.mode ?? 'form';
        const response = await client.request<CreateElicitationResponse>(
          methods.client.elicitation.create,
          {
            sessionId,
            message: act.message,
            ...(mode === 'form'
              ? { mode, requestedSchema: act.schema ?? { type: 'object', properties: {} } }
              : { mode, elicitationId: 'elicit-1', url: act.url ?? 'https://example.com' }),
          },
        );
        act.onAnswer(response);
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

      case 'fail':
        throw new Error(act.message);

      case 'stop':
        return {
          stopReason: act.reason,
          ...(act.usage ? { usage: act.usage } : {}),
          ...(act.meta ? { _meta: act.meta } : {}),
        };
    }
  }
  return { stopReason: signal.aborted ? 'cancelled' : 'end_turn' };
}
