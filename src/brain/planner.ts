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
  constructor(
    private current: ChatClient,
    private owned?: OwnedClient,
  ) {}

  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    return this.current.chat(messages, options);
  }

  /**
   * Plans through `next` from here on. The client it replaces is shut down
   * after the swap, so the process it was holding goes with it — awaited, so a
   * caller that reports the move reports it once the old one is actually gone.
   */
  async replace(next: OwnedClient): Promise<void> {
    const previous = this.owned;
    this.current = next;
    this.owned = next;
    if (previous && previous !== next) await previous.close();
  }

  async close(): Promise<void> {
    await this.owned?.close();
  }
}
