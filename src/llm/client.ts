import OpenAI from 'openai';
import type { Config } from '../config/schema.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LlmClient {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private supportsJsonFormat = true;

  constructor(cfg: Config['llm']) {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
    this.model = cfg.model;
    this.temperature = cfg.temperature;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    // Prefer constrained JSON output; fall back for servers that reject response_format.
    if (this.supportsJsonFormat) {
      try {
        return await this.complete(messages, true);
      } catch {
        this.supportsJsonFormat = false;
      }
    }
    return this.complete(messages, false);
  }

  private async complete(messages: ChatMessage[], jsonFormat: boolean): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: this.temperature,
      ...(jsonFormat ? { response_format: { type: 'json_object' as const } } : {}),
    });
    return res.choices[0]?.message?.content ?? '';
  }
}
