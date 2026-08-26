import OpenAI from 'openai';
import type { Config } from '../config/schema.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Ask the server to constrain output to a JSON object. Default true. */
  json?: boolean;
  signal?: AbortSignal;
}

/** The slice of {@link LlmClient} the orchestrator uses, so tests can stand in for it. */
export interface ChatClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

/**
 * The one failure worth downgrading on: a server that understood the request and
 * rejected `response_format`. Auth failures, refused connections and 500s must
 * propagate — silently retrying them without JSON mode only hides the real cause.
 */
function rejectsJsonFormat(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  if (e?.status !== 400) return false;
  return /response_format|json_object|json[_ ]schema/i.test(e.message ?? '');
}

export class LlmClient {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private supportsJsonFormat = true;

  constructor(cfg: Config['llm']) {
    this.client = new OpenAI({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs,
      // handsfree already retries at the action level; a wedged local server
      // should surface fast rather than be retried behind the user's back.
      maxRetries: 0,
    });
    this.model = cfg.model;
    this.temperature = cfg.temperature;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const wantJson = opts.json ?? true;
    if (wantJson && this.supportsJsonFormat) {
      try {
        return await this.complete(messages, true, opts.signal);
      } catch (err) {
        if (!rejectsJsonFormat(err)) throw err;
        this.supportsJsonFormat = false;
      }
    }
    return this.complete(messages, false, opts.signal);
  }

  private async complete(
    messages: ChatMessage[],
    jsonFormat: boolean,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        temperature: this.temperature,
        ...(jsonFormat ? { response_format: { type: 'json_object' as const } } : {}),
      },
      { signal },
    );
    return res.choices[0]?.message?.content ?? '';
  }
}
