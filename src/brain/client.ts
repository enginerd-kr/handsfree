import OpenAI from 'openai';
import type { Config } from '../config/schema.js';
import { debug } from '../debug.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface ChatOptions {
  /** Ask the endpoint to constrain the reply to this JSON Schema, if it can. */
  schema?: JsonSchemaSpec;
  signal?: AbortSignal;
}

export interface ChatClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

/**
 * Which way of asking for JSON this endpoint accepts. Local servers disagree:
 * LM Studio wants `json_schema` and rejects `json_object` outright, older
 * llama.cpp builds accept only `json_object`, and some accept neither. Guessing
 * wrong fails the request rather than degrading, so the first failure is used to
 * pick the next rung down and remembered.
 */
type Mode = 'json_schema' | 'json_object' | 'text';

const NEXT: Record<Mode, Mode> = {
  json_schema: 'json_object',
  json_object: 'text',
  text: 'text',
};

/**
 * The local orchestration model. It routes work and writes the summary; it
 * never decides whether a side effect is allowed. Keeping it out of the policy
 * path is what makes it safe to run a small, quantised model here.
 */
export class LocalModel implements ChatClient {
  private readonly client: OpenAI;
  private mode: Mode = 'json_schema';

  constructor(private readonly config: Config['orchestration']['local']) {
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      maxRetries: 1,
    });
    debug(
      'llm',
      `local endpoint ${config.baseURL}, model ${config.model} ` +
        '(reached with Node fetch, which ignores HTTP(S)_PROXY variables)',
    );
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (!options.schema) return this.send(messages, undefined, options.signal);

    for (;;) {
      const mode = this.mode;
      try {
        return await this.send(messages, mode === 'text' ? undefined : mode, options.signal, options.schema);
      } catch (err) {
        if (mode === 'text' || !isFormatRejection(err)) throw err;
        // The endpoint told us it cannot honour this way of asking. Step down
        // and try again rather than reporting a planning failure the user can
        // do nothing about.
        this.mode = NEXT[mode];
      }
    }
  }

  private async send(
    messages: ChatMessage[],
    mode: Exclude<Mode, 'text'> | undefined,
    signal: AbortSignal | undefined,
    schema?: JsonSchemaSpec,
  ): Promise<string> {
    const response_format =
      mode === 'json_schema' && schema
        ? { type: 'json_schema' as const, json_schema: { name: schema.name, schema: schema.schema, strict: false } }
        : mode === 'json_object'
          ? { type: 'json_object' as const }
          : undefined;

    let response;
    try {
      response = await this.client.chat.completions.create(
        {
          model: this.config.model,
          temperature: this.config.temperature,
          messages,
          ...(response_format ? { response_format } : {}),
        },
        { signal },
      );
    } catch (err) {
      const error = err as { status?: number; message?: string };
      debug(
        'llm',
        `request to ${this.config.baseURL} failed` +
          `${error.status !== undefined ? ` (HTTP ${error.status})` : ''}: ${error.message ?? String(err)}`,
      );
      throw err;
    }
    return response.choices[0]?.message?.content ?? '';
  }
}

/** True when the endpoint refused the *shape* of the request, not the content. */
function isFormatRejection(err: unknown): boolean {
  const error = err as { status?: number; message?: string };
  if (error.status !== undefined && error.status !== 400 && error.status !== 422) return false;
  return /response_format|json_schema|json_object|schema/i.test(error.message ?? '');
}

/** Keeps the system prompt and the most recent window. */
export function trimHistory(messages: ChatMessage[], max: number): ChatMessage[] {
  if (messages.length <= max + 1) return messages;
  const [system, ...rest] = messages;
  return system ? [system, ...rest.slice(rest.length - max)] : messages.slice(-max);
}
