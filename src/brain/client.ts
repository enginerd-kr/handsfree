import OpenAI from 'openai';
import type { Config } from '../config/schema.js';
import { debug } from '../debug.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Required task context, which history eviction must never discard. */
  pinned?: boolean;
  /** Required portion of a pinned message, excluding optional run history. */
  requiredContent?: string;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

/** What one reply cost, as the endpoint counted it. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  cachedWriteTokens?: number;
}

export interface ChatOptions {
  maxOutputTokens?: number;
  /** Ask the endpoint to constrain the reply to this JSON Schema, if it can. */
  schema?: JsonSchemaSpec;
  signal?: AbortSignal;
  /**
   * Called once with the endpoint's own token count for the exchange, where it
   * gives one. Not every endpoint does — an agent driven over ACP reports
   * one only where its CLI counts — so a caller that needs a number it can
   * always have measures the prompt itself and treats this as the better
   * figure when it arrives.
   */
  onUsage?: (usage: Usage) => void;
  /**
   * Called with each piece of the reply as the model writes it. The full reply
   * is still the return value; the pieces exist so a caller can show text the
   * moment it exists instead of after the last token.
   */
  onDelta?: (text: string) => void;
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
  /**
   * Whether a streamed reply can carry its token count. It takes
   * `stream_options.include_usage`, which llama.cpp, LM Studio and Ollama all
   * accept today but older builds refuse outright — and a refused request is
   * a planning failure, so the first refusal turns it off for the run.
   */
  private usageInStream = true;

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
    if (!options.schema) return this.send(messages, undefined, options);

    for (;;) {
      const mode = this.mode;
      try {
        return await this.send(messages, mode === 'text' ? undefined : mode, options);
      } catch (err) {
        if (mode === 'text' || !isFormatRejection(err)) throw err;
        // The endpoint told us it cannot honour this way of asking. Step down
        // and try again rather than reporting a planning failure the user can
        // do nothing about. A format rejection fails the request itself, so no
        // deltas have been sent when this retries.
        this.mode = NEXT[mode];
      }
    }
  }

  private async send(
    messages: ChatMessage[],
    mode: Exclude<Mode, 'text'> | undefined,
    { schema, signal, onDelta, onUsage, maxOutputTokens }: ChatOptions,
  ): Promise<string> {
    const response_format =
      mode === 'json_schema' && schema
        ? { type: 'json_schema' as const, json_schema: { name: schema.name, schema: schema.schema, strict: false } }
        : mode === 'json_object'
          ? { type: 'json_object' as const }
          : undefined;

    const request = {
      model: this.config.model,
      temperature: this.config.temperature,
      messages: wireMessages(messages),
      max_tokens: maxOutputTokens ?? this.config.maxOutputTokens,
      ...(response_format ? { response_format } : {}),
    };
    const report = (usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null | undefined) => {
      if (!onUsage || !usage) return;
      onUsage({ promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0,
        ...(usage.prompt_tokens_details?.cached_tokens === undefined ? {} : { cachedTokens: usage.prompt_tokens_details.cached_tokens }) });
    };
    try {
      if (onDelta) {
        const withUsage = onUsage !== undefined && this.usageInStream;
        const stream = await this.client.chat.completions
          .create(
            { ...request, stream: true, ...(withUsage ? { stream_options: { include_usage: true } } : {}) },
            { signal },
          )
          .catch(async (err: unknown) => {
            // Any refusal of the request's *shape* is taken as a refusal of
            // the one thing we added to it. A server that rejects
            // `stream_options` without naming it would otherwise fail every
            // planning call for the rest of the run, and a token count is
            // never worth that — so the count is what gets dropped.
            if (!withUsage || signal?.aborted || !isRequestRejection(err)) throw err;
            this.usageInStream = false;
            return this.client.chat.completions.create({ ...request, stream: true }, { signal });
          });
        let text = '';
        for await (const chunk of stream) {
          // The count rides on a final chunk of its own, with no choices in it.
          if (chunk.usage) report(chunk.usage);
          const delta = chunk.choices[0]?.delta?.content ?? '';
          if (delta === '') continue;
          text += delta;
          onDelta(delta);
        }
        return text;
      }
      const response = await this.client.chat.completions.create(request, { signal });
      report(response.usage);
      return response.choices[0]?.message?.content ?? '';
    } catch (err) {
      const error = err as { status?: number; message?: string };
      debug(
        'llm',
        `request to ${this.config.baseURL} failed` +
          `${error.status !== undefined ? ` (HTTP ${error.status})` : ''}: ${error.message ?? String(err)}`,
      );
      throw err;
    }
  }
}

/** Small-model chat templates often require alternating roles after eviction/repair. */
export function wireMessages(messages: readonly ChatMessage[]): { role: ChatMessage['role']; content: string }[] {
  const result: { role: ChatMessage['role']; content: string }[] = [];
  for (const { role, content } of messages) {
    const last = result.at(-1);
    if (last?.role === role) last.content += `\n\n${content}`;
    else result.push({ role, content });
  }
  return result;
}

/** True when the endpoint refused the *shape* of the request, not the content. */
function isFormatRejection(err: unknown): boolean {
  const error = err as { status?: number; message?: string };
  if (error.status !== undefined && error.status !== 400 && error.status !== 422) return false;
  return /response_format|json_schema|json_object|schema/i.test(error.message ?? '');
}

/** True when the endpoint rejected the request as malformed rather than failing on it. */
function isRequestRejection(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 400 || status === 422;
}

/** Keeps the system prompt and the most recent window. */
export function trimHistory(messages: ChatMessage[], max: number): ChatMessage[] {
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  const body = (system ? messages.slice(1) : messages).slice(-max);
  while (body[0]?.role === 'assistant') body.shift();
  return [...(system ? [system] : []), ...body];
}

/**
 * Tokens, roughly, without a tokenizer: four characters each for ASCII, and a
 * character and a half for everything else — CJK, mostly, which the tokenizers
 * that matter here split closer to a token per character. This is a heuristic,
 * not a tokenizer guarantee; reported usage replaces estimates when available.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

export function estimateMessages(messages: readonly ChatMessage[]): number {
  // A few tokens per message for the role and the framing around it.
  return messages.reduce((total, message) => total + estimateTokens(message.content) + 4, 0);
}

/**
 * The conversation cut to a budget from the middle: the system prompt stays,
 * the last message stays, and the oldest of what lies between goes first, a
 * user/assistant pair at a time so the shape a chat template expects survives.
 * Required task messages survive eviction. If these cannot fit, fail before
 * a model call rather than silently discarding the goal or exceeding the cap.
 */
export class ContextBudgetError extends Error {
  constructor(readonly required: number, readonly budget: number) {
    super(`Required task context needs approximately ${required} tokens; input budget is ${budget}. Shorten the request or increase contextBudgetTokens.`);
    this.name = 'ContextBudgetError';
  }
}

export function fitBudget(messages: readonly ChatMessage[], budgetTokens: number): ChatMessage[] {
  if (estimateMessages(messages) <= budgetTokens) return [...messages];
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  const body = (system ? messages.slice(1) : [...messages]).map((message) =>
    message.pinned && message.requiredContent !== undefined ? { ...message, content: message.requiredContent } : message);
  const last = body.at(-1);
  if (!last) throw new ContextBudgetError(estimateMessages(messages), budgetTokens);
  let middle = body.slice(0, -1);
  const frame = () => [...(system ? [system] : []), ...middle, last];
  while (middle.length > 0 && estimateMessages(frame()) > budgetTokens) {
    // Drop from the front, and keep dropping until the front is a user line
    // again: an assistant reply with no user line before it is the shape some
    // templates refuse.
    const at = middle.findIndex((message) => !message.pinned);
    if (at === -1) break;
    middle.splice(at, 1);
    while (middle[at]?.role === 'assistant' && !middle[at]?.pinned) middle.splice(at, 1);
  }
  const result = frame();
  if (estimateMessages(result) > budgetTokens) throw new ContextBudgetError(estimateMessages(result), budgetTokens);
  return result;
}
