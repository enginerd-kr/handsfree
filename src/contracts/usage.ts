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

/**
 * What one turn cost, as the agent counted it. `inputTokens` is what was read
 * fresh; a cached read or write is counted apart, the way the agents report
 * it, and `totalTokens` is the agent's own sum where it gave one.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}
