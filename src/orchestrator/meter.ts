import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { Transcript, TranscriptRecord } from '../workspace/transcript.js';

export interface TokenCharge {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  estimated: boolean;
  /** Provider-reported USD for this call, when available. */
  costUsd?: number;
}

export interface TokenUsage extends TokenCharge {
  id: string;
  source: string;
  model: string;
  frontierTokens: number;
  costUsd?: number;
  failed: boolean;
}

/** Records usage for reporting and routing; never admits or cancels work. */
export class UsageTracker {
  private readonly spent = { tokens: 0, frontierTokens: 0, costUsd: 0, unknownCostCalls: 0, estimatedCalls: 0 };
  private readonly onRecord = (record: TranscriptRecord) => {
    if (record.type !== 'budget_usage') return;
    const usage = record.usage;
    this.spent.tokens += usage.tokens;
    this.spent.frontierTokens += usage.frontierTokens;
    this.spent.costUsd += usage.costUsd ?? 0;
    this.spent.unknownCostCalls += usage.costUsd === undefined && usage.tokens > 0 ? 1 : 0;
    this.spent.estimatedCalls += usage.estimated ? 1 : 0;
  };

  constructor(private readonly config: Config, private readonly transcript: Transcript) {
    for (const record of transcript.all()) this.onRecord(record);
    transcript.on('record', this.onRecord);
  }

  close(): void { this.transcript.off('record', this.onRecord); }

  totals() { return { ...this.spent }; }

  record(source: string, model: string, frontier: boolean, charge: TokenCharge, failed = false): TokenUsage {
    const costUsd = !frontier || charge.tokens === 0 ? 0 : this.price(source, model, charge);
    const usage: TokenUsage = { ...charge, id: randomUUID(), source, model,
      frontierTokens: frontier ? charge.tokens : 0, failed, ...(costUsd === undefined ? {} : { costUsd }) };
    // Keep the persisted event name so existing transcripts retain their usage history.
    this.transcript.append({ type: 'budget_usage', usage });
    return usage;
  }

  price(source: string, model: string, charge: TokenCharge): number | undefined {
    if (charge.costUsd !== undefined) return charge.costUsd;
    const rate = this.config.prices[model] ?? this.config.prices[source];
    if (!rate) return undefined;
    return (charge.inputTokens * rate.input + charge.outputTokens * rate.output
      + (charge.cachedReadTokens ?? 0) * (rate.cachedRead ?? rate.input)
      + (charge.cachedWriteTokens ?? 0) * (rate.cachedWrite ?? rate.input)) / 1_000_000;
  }

}
