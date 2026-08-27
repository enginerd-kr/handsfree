import type {
  ContentBlock,
  PromptRequest,
  PromptResponse,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';

export interface SessionTransport {
  prompt(request: PromptRequest, signal: AbortSignal): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
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

  constructor(
    readonly agentId: string,
    readonly sessionId: string,
    private readonly transport: SessionTransport,
    private readonly onUpdate: (update: SessionUpdate) => void,
  ) {}

  /** Called by the connection for every `session/update` addressed to us. */
  receive(update: SessionUpdate): void {
    this.lastUpdateAt = Date.now();
    this.onUpdate(update);
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

    const deadline = setTimeout(() => turn.abort(), options.turnTimeoutMs);
    const idle = setInterval(() => {
      if (Date.now() - this.lastUpdateAt > options.idleTimeoutMs) turn.abort();
    }, Math.min(options.idleTimeoutMs, 5_000));

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
      clearTimeout(deadline);
      clearInterval(idle);
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
