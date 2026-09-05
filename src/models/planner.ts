import type { ChatClient, ChatMessage, ChatOptions } from './client.js';

/** Which agent plans, and on which model. The model is the agent's default when absent. */
export interface OrchestrationChoice {
  agent: string;
  model?: string;
}

/** A client this run started, and is therefore responsible for shutting down. */
type OwnedClient = ChatClient & { close(): Promise<void> };

/**
 * The orchestration model as one thing the conversation can hold while the
 * model behind it changes. `@orchestrator:agent:model` is a live setting, and
 * a conversation rebuilt around a new client would be a conversation that had
 * forgotten what was said to it — so the client moves and the conversation
 * stays.
 *
 * Only a client this run started is closed when it is replaced. One handed in
 * from outside is used and left alone: we did not start it, and something else
 * is still holding it.
 */
export class Planner implements ChatClient {
  private readonly retiring: Promise<void>[] = [];
  constructor(
    private current: ChatClient,
    private owned?: OwnedClient,
  ) {}

  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    return this.current.chat(messages, options);
  }

  prepare(): void {
    (this.current as ChatClient & { prepare?(): void }).prepare?.();
  }

  /**
   * Plans through `next` from here on. The client it replaces is shut down
   * after the swap. Cleanup overlaps preparation of the replacement and is
   * joined at shutdown, so teardown does not delay the next reply.
   */
  async replace(next: OwnedClient): Promise<void> {
    const previous = this.owned;
    this.current = next;
    this.owned = next;
    this.prepare();
    if (previous && previous !== next) {
      const closing = previous.close();
      void closing.catch(() => {});
      this.retiring.push(closing);
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([this.owned?.close(), ...this.retiring]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
