import { randomUUID } from 'node:crypto';
import type { Config, TokenBudget } from '../config/schema.js';
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

export interface BudgetUsage extends TokenCharge {
  id: string;
  source: string;
  model: string;
  frontierTokens: number;
  costUsd?: number;
  failed: boolean;
}

export class BudgetExceededError extends Error {
  constructor(message: string) { super(message); this.name = 'BudgetExceededError'; }
}

export interface BudgetLease {
  signal: AbortSignal;
  exceeded(): boolean;
  setModel(model: string): void;
  observe(tokens: number): void;
  finish(charge: TokenCharge, failed?: boolean): BudgetUsage;
}

/** Reservations are synchronous so concurrent tasks cannot spend the same remaining budget. */
export class BudgetManager {
  private readonly active = new Map<string, { tokens: number; frontier: boolean; cost?: number; stop: AbortController }>();
  private readonly spent = { tokens: 0, frontierTokens: 0, costUsd: 0, unknownCostCalls: 0, estimatedCalls: 0 };
  private readonly record = (record: TranscriptRecord) => {
    if (record.type !== 'budget_usage') return;
    const usage = record.usage;
    this.spent.tokens += usage.tokens;
    this.spent.frontierTokens += usage.frontierTokens;
    this.spent.costUsd += usage.costUsd ?? 0;
    this.spent.unknownCostCalls += usage.costUsd === undefined && usage.tokens > 0 ? 1 : 0;
    this.spent.estimatedCalls += usage.estimated ? 1 : 0;
  };
  constructor(private readonly config: Config, private readonly transcript: Transcript) {
    for (const record of transcript.all()) this.record(record);
    transcript.on('record', this.record);
  }

  close(): void { this.transcript.off('record', this.record); }

  totals() {
    return { ...this.spent };
  }

  price(source: string, model: string, charge: TokenCharge): number | undefined {
    if (charge.costUsd !== undefined) return charge.costUsd;
    const rate = this.config.prices[model] ?? this.config.prices[source];
    if (!rate) return undefined;
    return (charge.inputTokens * rate.input + charge.outputTokens * rate.output
      + (charge.cachedReadTokens ?? 0) * (rate.cachedRead ?? rate.input)
      + (charge.cachedWriteTokens ?? 0) * (rate.cachedWrite ?? rate.input)) / 1_000_000;
  }

  estimateCost(source: string, model: string, tokens: number, frontier: boolean): number | undefined {
    if (!frontier) return 0;
    const rate = this.config.prices[model] ?? this.config.prices[source];
    return rate ? tokens * Math.max(rate.input, rate.output, rate.cachedRead ?? 0, rate.cachedWrite ?? 0) / 1_000_000 : undefined;
  }

  canStart(tokens: number, frontier: boolean, cost?: number): boolean {
    return this.reason(tokens, frontier, cost) === undefined;
  }

  private reason(tokens: number, frontier: boolean, cost?: number): string | undefined {
    const total = this.totals();
    const pending = [...this.active.values()];
    const used = total.tokens + pending.reduce((n, p) => n + p.tokens, 0);
    const remote = total.frontierTokens + pending.reduce((n, p) => n + (p.frontier ? p.tokens : 0), 0);
    const limits = this.config.budget;
    if (limits.maxTokens !== undefined && used + tokens > limits.maxTokens) return 'Run token budget exhausted';
    if (limits.maxFrontierTokens !== undefined && remote + (frontier ? tokens : 0) > limits.maxFrontierTokens) return 'Frontier token budget exhausted';
    if (limits.maxCostUsd !== undefined) {
      if (cost === undefined || total.unknownCostCalls > 0 || pending.some((p) => p.cost === undefined)) return 'A USD budget requires configured prices for every model';
      if (total.costUsd + pending.reduce((n, p) => n + (p.cost ?? 0), 0) + cost > limits.maxCostUsd) return 'Run USD budget exhausted';
    }
    return undefined;
  }

  begin(source: string, model: string, frontier: boolean, estimate: number, limits: TokenBudget = {}): BudgetLease {
    const cost = this.estimateCost(source, model, estimate, frontier);
    const reason = this.reason(estimate, frontier, cost);
    const perTask = Math.min(this.config.budget.maxTaskTokens, limits.maxTokens ?? Infinity,
      frontier ? limits.maxFrontierTokens ?? Infinity : Infinity);
    if (reason) throw new BudgetExceededError(reason);
    if (estimate > perTask) throw new BudgetExceededError(`Estimated ${estimate} tokens exceed task budget ${perTask}`);
    if (limits.maxCostUsd !== undefined && (cost === undefined || cost > limits.maxCostUsd)) throw new BudgetExceededError('Task USD budget cannot cover the estimated call');
    const id = randomUUID();
    const stop = new AbortController();
    const state = { tokens: estimate, frontier, cost, stop };
    this.active.set(id, state);
    let finished: BudgetUsage | undefined;
    return {
      signal: stop.signal,
      exceeded: () => stop.signal.aborted,
      setModel: (selected) => {
        model = selected;
        state.cost = this.estimateCost(source, model, state.tokens, frontier);
        if (this.reason(0, false, 0) || (limits.maxCostUsd !== undefined && (state.cost ?? Infinity) > limits.maxCostUsd)) {
          stop.abort();
          throw new BudgetExceededError('Selected model cannot fit the USD budget');
        }
      },
      observe: (tokens) => {
        if (finished) return;
        state.tokens = Math.max(state.tokens, tokens);
        state.cost = this.estimateCost(source, model, state.tokens, frontier);
        if (tokens > perTask || (limits.maxCostUsd !== undefined && (state.cost ?? Infinity) > limits.maxCostUsd) || this.reason(0, false, 0)) stop.abort();
      },
      finish: (charge, failed = false) => {
        if (finished) return finished;
        this.active.delete(id);
        const actualCost = !frontier || charge.tokens === 0 ? 0 : this.price(source, model, charge);
        const overBudget = charge.tokens > perTask
          || (limits.maxCostUsd !== undefined && (actualCost ?? Infinity) > limits.maxCostUsd)
          || this.reason(charge.tokens, frontier, actualCost) !== undefined;
        if (overBudget) stop.abort();
        finished = { ...charge, id, source, model, frontierTokens: frontier ? charge.tokens : 0, failed: failed || stop.signal.aborted,
          ...(actualCost === undefined ? {} : { costUsd: actualCost }) };
        this.transcript.append({ type: 'budget_usage', usage: finished });
        if (this.reason(0, false, 0)) {
          stop.abort();
          for (const pending of this.active.values()) pending.stop.abort();
        }
        return finished;
      },
    };
  }
}
