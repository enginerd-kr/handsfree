import type { TurnUsage } from '../contracts/usage.js';
import type {
  ContentBlock,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionConfigSelectOptions,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import { resolveModel, type ModelChoice } from './models.js';

export interface SessionTransport {
  prompt(request: PromptRequest, signal: AbortSignal): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  /** The spec'd switch: a `select` config option in the `model` category. */
  setConfigOption(request: { sessionId: string; configId: string; value: string }): Promise<void>;
  /** The draft `session/set_model`, for the adapters still on the older dialect. */
  setModel(request: { sessionId: string; modelId: string }): Promise<void>;
}

/**
 * What an agent said about models when a session opened: which it offers,
 * which it is on, and how it takes a switch. The agent is the authority —
 * every adapter handsfree ships with is the CLI's own current one, so the
 * roster it advertises is the roster the CLI has.
 */
export interface ModelState {
  wire: { kind: 'config_option'; configId: string } | { kind: 'set_model' };
  current: string;
  choices: ModelChoice[];
}

/** The draft `models` field, off the SDK's schema but not stripped from the wire. */
interface UnstableModelState {
  availableModels: { modelId: string; name?: string; description?: string | null }[];
  currentModelId: string;
}

/**
 * Reads the roster off a `session/new` or `session/load` answer, in whichever
 * dialect it came: a `select` config option in the `model` category, or the
 * draft `models` field. Config options win when both are present — they are
 * the spec'd of the two.
 */
export function modelStateOf(response: {
  configOptions?: readonly SessionConfigOption[] | null;
  models?: unknown;
}): ModelState | undefined {
  const selects = (response.configOptions ?? []).filter((option) => option.type === 'select');
  const option =
    selects.find((entry) => entry.category === 'model') ??
    selects.find((entry) => entry.id === 'model');
  if (option) {
    return {
      wire: { kind: 'config_option', configId: option.id },
      current: option.currentValue,
      choices: flatten(option.options),
    };
  }
  const draft = response.models as UnstableModelState | undefined;
  if (draft?.availableModels) {
    return {
      wire: { kind: 'set_model' },
      current: draft.currentModelId,
      choices: draft.availableModels.map((model) => ({
        value: model.modelId,
        ...(model.description ? { description: model.description } : {}),
      })),
    };
  }
  return undefined;
}

/** Select options arrive flat or under group headers; either way, one list. */
function flatten(options: SessionConfigSelectOptions): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const entry of options) {
    for (const option of 'options' in entry ? entry.options : [entry]) {
      choices.push({
        value: option.value,
        ...(option.description ? { description: option.description } : {}),
      });
    }
  }
  return choices;
}

/** How a turn ended, and what it cost where the agent said. */
export interface TurnEnd {
  stopReason: StopReason;
  usage?: TurnUsage;
}

/** The token count gemini sends in place of the spec'd `usage` field. */
interface QuotaMeta {
  quota?: { token_count?: { input_tokens?: number; output_tokens?: number } | null } | null;
}

/**
 * The turn's token count, read off the prompt response in whichever spelling
 * the agent used. The spec's `usage` field is still marked unstable, and
 * claude-agent-acp and codex-acp fill it; gemini-cli does not, and puts the
 * same two figures under `_meta.quota.token_count` instead. An agent that
 * sent neither cost something too, but nobody here knows how much.
 */
export function usageOf(response: PromptResponse): TurnUsage | undefined {
  const usage = response.usage;
  if (usage) {
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      ...(usage.cachedReadTokens == null ? {} : { cachedReadTokens: usage.cachedReadTokens }),
      ...(usage.cachedWriteTokens == null ? {} : { cachedWriteTokens: usage.cachedWriteTokens }),
      ...(usage.thoughtTokens == null ? {} : { thoughtTokens: usage.thoughtTokens }),
    };
  }
  const count = (response._meta as QuotaMeta | null | undefined)?.quota?.token_count;
  if (!count) return undefined;
  const inputTokens = count.input_tokens ?? 0;
  const outputTokens = count.output_tokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export interface PromptOptions {
  signal?: AbortSignal;
}

export class SessionUnresponsiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionUnresponsiveError';
  }
}

/**
 * One conversation with one agent. Prompts are serialised: ACP allows a single
 * turn at a time per session, and overlapping them would make the update stream
 * ambiguous about which turn an update belongs to.
 */
export class HostSession {
  private turn: AbortController | undefined;
  private busy = false;
  private lastUpdateAt = 0;
  private readonly listeners = new Set<(update: SessionUpdate) => void>();
  invalidated = false;
  /** What the agent said about models, once its opening answer has said it. */
  private state: ModelState | undefined;
  /**
   * Whether the agent is replaying this session's past to us — the stretch of
   * `session/load` before it answers. Updates that arrive then are history the
   * record already holds, not news.
   */
  replaying = false;

  constructor(
    readonly agentId: string,
    readonly sessionId: string,
    private readonly transport: SessionTransport,
    private readonly onUpdate: (update: SessionUpdate) => void,
    private readonly dispose: () => Promise<void> = async () => {},
  ) {}

  /**
   * The roster a `session/new` or `session/load` answered with. Kept apart
   * from the constructor because a loaded session has to exist before the load
   * resolves — the replayed updates land on it.
   */
  adoptModelState(state: ModelState | undefined): void {
    if (state) this.state = state;
  }

  /**
   * Resolves once no update has arrived for `gapMs`, or after `capMs` in any
   * case. For the tail of a `session/load`: an agent may answer the load
   * before it has finished replaying the conversation — gemini does, in a
   * burst a few milliseconds long — and a prompt sent into that burst would
   * have the replay recorded as its own.
   */
  async untilQuiet(gapMs: number, capMs: number): Promise<void> {
    const started = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - started >= capMs) return;
      const idle = now - this.lastUpdateAt;
      if (idle >= gapMs) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(gapMs - idle, capMs - (now - started))));
    }
  }

  /** Called by the connection for every `session/update` addressed to us. */
  receive(update: SessionUpdate): void {
    this.lastUpdateAt = Date.now();
    // An agent may move its own model mid-session and say so. Re-reading it
    // here is what keeps the roll call honest about what is actually loaded.
    if (update.sessionUpdate === 'config_option_update') {
      this.adoptModelState(modelStateOf({ configOptions: update.configOptions }));
    }
    this.onUpdate(update);
    for (const listener of this.listeners) listener(update);
  }

  subscribe(listener: (update: SessionUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The models this session's agent offers, in the order it offered them. */
  models(): readonly ModelChoice[] {
    return this.state?.choices ?? [];
  }

  /** The model the session is on, as the agent last reported or was told. */
  currentModel(): string | undefined {
    return this.state?.current;
  }

  /**
   * Switches the session to the model `wanted` names, matched the way a person
   * types it — the id exactly, then as a prefix, then anywhere in it. Nothing
   * or several is an error naming what the agent actually offers: the caller's
   * user typed blind, and the roster is the answer they need.
   */
  async selectModel(wanted: string): Promise<ModelChoice> {
    const state = this.state;
    if (!state) {
      throw new Error(
        `${this.agentId} offers no model selection over ACP; ` +
          'pin the model in its launch profile instead.',
      );
    }
    const resolved = resolveModel(wanted, state.choices, this.agentId);
    if (resolved.value === state.current) return resolved;

    if (state.wire.kind === 'config_option') {
      await this.transport.setConfigOption({
        sessionId: this.sessionId,
        configId: state.wire.configId,
        value: resolved.value,
      });
    } else {
      // The draft dialect answers with nothing and notifies nothing; the
      // request succeeding is the whole confirmation, so the state moves here.
      await this.transport.setModel({ sessionId: this.sessionId, modelId: resolved.value });
    }
    this.state = { ...state, current: resolved.value };
    return resolved;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Asks the agent to stop the current turn. Safe to call when idle. */
  cancel(): void {
    this.turn?.abort();
  }

  async prompt(
    prompt: string | ContentBlock[],
    options: PromptOptions = {},
  ): Promise<TurnEnd> {
    if (options.signal?.aborted) return { stopReason: 'cancelled' };
    if (this.invalidated) throw new SessionUnresponsiveError('Session was cancelled; open a new session');
    if (this.busy) throw new Error(`session ${this.sessionId} is already running a turn`);
    this.busy = true;

    const blocks: ContentBlock[] =
      typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
    const turn = new AbortController();
    this.turn = turn;

    const ended = async (): Promise<TurnEnd> => {
      const response = await this.transport.prompt(
        { sessionId: this.sessionId, prompt: blocks },
        turn.signal,
      );
      const usage = usageOf(response);
      return usage ? { stopReason: response.stopReason, usage } : { stopReason: response.stopReason };
    };

    // A signal that fired before we got here — Esc pressed while the process
    // was still starting or the session still opening — carries no event to
    // subscribe to, and a listener added now would never hear a thing.
    const abortOnCaller = () => turn.abort();
    if (options.signal?.aborted) turn.abort();
    else options.signal?.addEventListener('abort', abortOnCaller, { once: true });

    try {
      const pending = ended();
      const raced = await Promise.race([
        pending.then((end) => ({ done: true as const, end })),
        onAbort(turn.signal).then(() => ({ done: false as const, end: undefined })),
      ]);
      if (raced.done) return raced.end;

      void this.transport.cancel(this.sessionId).catch(() => {});
      return { stopReason: 'cancelled' };
    } catch (error) {
      if (!turn.signal.aborted) throw error;
      return { stopReason: 'cancelled' };
    } finally {
      options.signal?.removeEventListener('abort', abortOnCaller);
      this.turn = undefined;
      this.busy = false;
      if (turn.signal.aborted) {
        this.invalidated = true;
        await this.dispose();
      }
    }
  }
}

function onAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
