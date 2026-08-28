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

export interface PromptOptions {
  /** Wall clock for the whole turn. */
  turnTimeoutMs: number;
  /** How long the agent may go without sending any update. */
  idleTimeoutMs: number;
  /** How long to wait for a `cancelled` stop reason after asking it to stop. */
  cancelGraceMs: number;
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
  private lastUpdateAt = 0;
  private busy = false;
  /** What the agent said about models, once its opening answer has said it. */
  private state: ModelState | undefined;

  constructor(
    readonly agentId: string,
    readonly sessionId: string,
    private readonly transport: SessionTransport,
    private readonly onUpdate: (update: SessionUpdate) => void,
    /**
     * Whether a person is currently being asked something on this agent's
     * behalf. An agent blocked on a question of its own sends no updates and
     * makes no progress, and neither of those is the agent's fault — so the
     * timers below stand still until the answer comes back.
     */
    private readonly blocked: () => boolean = () => false,
  ) {}

  /**
   * The roster a `session/new` or `session/load` answered with. Kept apart
   * from the constructor because a loaded session has to exist before the load
   * resolves — the replayed updates land on it.
   */
  adoptModelState(state: ModelState | undefined): void {
    if (state) this.state = state;
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
    options: PromptOptions,
  ): Promise<StopReason> {
    if (this.busy) throw new Error(`session ${this.sessionId} is already running a turn`);
    this.busy = true;

    const blocks: ContentBlock[] =
      typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
    const turn = new AbortController();
    this.turn = turn;
    this.lastUpdateAt = Date.now();

    const stopReason = async () => {
      const response = await this.transport.prompt(
        { sessionId: this.sessionId, prompt: blocks },
        turn.signal,
      );
      return response.stopReason;
    };

    // A signal that fired before we got here — Esc pressed while the process
    // was still starting or the session still opening — carries no event to
    // subscribe to, and a listener added now would never hear a thing.
    const abortOnCaller = () => turn.abort();
    if (options.signal?.aborted) turn.abort();
    else options.signal?.addEventListener('abort', abortOnCaller, { once: true });

    // Both clocks are read from one tick so both can be stopped by one
    // condition. Time spent waiting on a person is not time the agent had:
    // the idle deadline is pushed along while it lasts and the wall clock
    // discounts it, or a question left up for two minutes would end the turn
    // that asked it — and the answer would land on a session already cancelled.
    const startedAt = Date.now();
    let blockedFor = 0;
    let blockedSince: number | undefined;
    const clock = setInterval(
      () => {
        const now = Date.now();
        if (this.blocked()) {
          blockedSince ??= now;
          this.lastUpdateAt = now;
          return;
        }
        if (blockedSince !== undefined) {
          blockedFor += now - blockedSince;
          blockedSince = undefined;
        }
        if (now - this.lastUpdateAt > options.idleTimeoutMs) turn.abort();
        else if (now - startedAt - blockedFor > options.turnTimeoutMs) turn.abort();
      },
      Math.min(options.idleTimeoutMs, options.turnTimeoutMs, 5_000),
    );

    try {
      const pending = stopReason();
      const raced = await Promise.race([
        pending.then((reason) => ({ done: true as const, reason })),
        onAbort(turn.signal).then(() => ({ done: false as const, reason: undefined })),
      ]);
      if (raced.done) return raced.reason;

      // Cancellation is cooperative: tell the agent to stop, then give it a
      // bounded moment to close the turn properly. A turn that will not close is
      // reported as unresponsive so the caller can tear the process down.
      await this.transport.cancel(this.sessionId).catch(() => {});
      // The grace timer must not outlive the race it loses: a live timer holds
      // the event loop, which on /quit is ten more seconds of a process that
      // looks hung.
      let grace: NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        pending.then((reason) => reason).catch(() => 'cancelled' as StopReason),
        new Promise<undefined>((resolve) => {
          grace = setTimeout(() => resolve(undefined), options.cancelGraceMs);
        }),
      ]).finally(() => clearTimeout(grace));
      if (settled === undefined) {
        throw new SessionUnresponsiveError(
          `${this.agentId} did not end its turn ${options.cancelGraceMs}ms after being cancelled`,
        );
      }
      return settled;
    } finally {
      clearInterval(clock);
      options.signal?.removeEventListener('abort', abortOnCaller);
      this.turn = undefined;
      this.busy = false;
    }
  }
}

function onAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
