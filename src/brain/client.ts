import OpenAI from 'openai';
import type { Config } from '../config/schema.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Ask the endpoint for a JSON object. Ignored by servers that do not support it. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ChatClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

/**
 * The local model. It routes work and writes the summary; it never decides
 * whether a side effect is allowed. Keeping it out of the policy path is what
 * makes it safe to run a small, quantised model here.
 */
export class LocalModel implements ChatClient {
  private readonly client: OpenAI;

  constructor(private readonly config: Config['llm']) {
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      maxRetries: 1,
    });
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: this.config.model,
        temperature: this.config.temperature,
        messages,
        ...(options.json ? { response_format: { type: 'json_object' as const } } : {}),
      },
      { signal: options.signal },
    );
    return response.choices[0]?.message?.content ?? '';
  }
}

/** Keeps the system prompt and the most recent window. */
export function trimHistory(messages: ChatMessage[], max: number): ChatMessage[] {
  if (messages.length <= max + 1) return messages;
  const [system, ...rest] = messages;
  return system ? [system, ...rest.slice(rest.length - max)] : messages.slice(-max);
}
