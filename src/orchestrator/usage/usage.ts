import { estimateTokens as countTokens, estimateMessages, type ChatClient, type Usage } from '../../models/client.js';
import type { UsageTracker } from './meter.js';
import type { TokenUsage } from '../../contracts/usage.js';
import { debug } from '../../debug.js';
import type { TurnUsage } from '../../contracts/usage.js';
import type { Transcript, TranscriptRecord } from '../../workspace/transcript.js';

/**
 * The orchestration model, with every call written down: how much was sent,
 * how much came back, and the endpoint's own token count where it gives one.
 * The point of a small planner is that planning stays small, and the only way
 * to know it has is to be able to read the figure after the fact.
 */
export function metered(
  llm: ChatClient,
  purpose: 'plan' | 'narrate',
  transcript: Transcript,
  /** The planner as the roll call spells it, read when the call is made. */
  model?: string,
  budget?: { manager: UsageTracker; frontier: boolean; onCharge?: (usage: TokenUsage) => void },
): ChatClient {
  return {
    async chat(messages, options = {}) {
      const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
      const inputEstimate = estimateMessages(messages) + (options.schema ? countTokens(JSON.stringify(options.schema.schema)) : 0);
      let usage: Usage | undefined;
      let reply = '';
      let failed = true;
      const lease = budget?.manager.begin('orchestrator', model ?? 'orchestrator', budget.frontier);
      try {
        reply = await llm.chat(messages, {
          ...options,
          onDelta: (text) => {
            reply += text;
            options.onDelta?.(text);
          },
          onUsage: (counted) => {
            usage = counted;
            options.onUsage?.(counted);
          },
        });
        failed = false;
        return reply;
      } finally {
        const estimatedTokens = inputEstimate + countTokens(reply);
        const measured = { tokens: usage ? usage.promptTokens + usage.completionTokens : estimatedTokens,
          inputTokens: usage ? Math.max(0, usage.promptTokens - (usage.cachedTokens ?? 0) - (usage.cachedWriteTokens ?? 0)) : inputEstimate,
          outputTokens: usage?.completionTokens ?? countTokens(reply), cachedReadTokens: usage?.cachedTokens,
          cachedWriteTokens: usage?.cachedWriteTokens,
          estimated: usage === undefined };
        const charge = lease?.finish(measured, failed);
        if (charge) budget?.onCharge?.(charge);
        transcript.append({
          type: 'usage',
          purpose,
          ...(model === undefined ? {} : { model }),
          promptChars,
          replyChars: reply.length,
          ...(usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : {}),
          ...(usage?.cachedTokens === undefined ? {} : { cachedTokens: usage.cachedTokens }),
          ...(usage?.cachedWriteTokens === undefined ? {} : { cachedWriteTokens: usage.cachedWriteTokens }),
          estimatedTokens,
        });
        debug(
          'llm',
          `${purpose}: ${messages.length} messages, ${promptChars} chars in, ${reply.length} out` +
            (usage ? ` (${usage.promptTokens} + ${usage.completionTokens} tokens)` : ''),
        );
      }
    },
  };
}

/**
 * What one party to the run has spent so far: the orchestrator, or one agent.
 * `tokens` is the figure a glance wants — everything the turns took, cached
 * reads included — and the rest is how it breaks down. For the orchestrator
 * `estimated` says the figure is handsfree's own count of characters, because
 * the endpoint gave none; an agent's turns are counted or not counted, and
 * `counted` says how many of `turns` were.
 */
export interface Spend {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  turns: number;
  counted: number;
  estimated: boolean;
  /** How full the agent's context is, as it last said — where it says. */
  context?: { used: number; size: number };
}

export interface RunSpend {
  orchestrator: Spend;
  agents: Record<string, Spend>;
  /**
   * The same spend by the model that spent it, in the order the models were
   * first used. An agent's turns go by the model its session was on when
   * each ended; the planner's calls by the planner as the roll call spelled
   * it then — so a run that moved either mid-way keeps each figure with the
   * model that earned it.
   */
  models: { label: string; spend: Spend }[];
}

function nothing(): Spend {
  return { tokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0, counted: 0, estimated: false };
}

/** Everything a turn took, as the agent summed it or as the parts add up. */
export function tokensOf(usage: TurnUsage): number {
  return (
    usage.totalTokens ??
    usage.inputTokens +
      usage.outputTokens +
      (usage.cachedReadTokens ?? 0) +
      (usage.cachedWriteTokens ?? 0) +
      (usage.thoughtTokens ?? 0)
  );
}

/**
 * The run's spend, read off the record: the orchestrator's from the usage
 * records its calls left, each agent's from the count on each of its stops,
 * and how full each agent's context is from the last `usage_update` it sent.
 * Replayed from the transcript rather than kept as state, like the view is,
 * so a resumed run reads the same figures the first process showed.
 */
export function spendOf(records: readonly TranscriptRecord[]): RunSpend {
  const orchestrator = nothing();
  const agents: Record<string, Spend> = {};
  const models = new Map<string, Spend>();
  const of = (agentId: string): Spend => (agents[agentId] ??= nothing());
  const on = (label: string): Spend => {
    let spend = models.get(label);
    if (!spend) models.set(label, (spend = nothing()));
    return spend;
  };
  for (const record of records) {
    switch (record.type) {
      case 'usage': {
        if (record.purpose === 'task') break;
        for (const spend of [orchestrator, on(record.model ?? 'orchestrator')]) {
          spend.turns++;
          if (record.promptTokens !== undefined) {
            spend.counted++;
            spend.inputTokens += record.promptTokens;
            spend.outputTokens += record.completionTokens ?? 0;
            spend.cachedTokens += (record.cachedTokens ?? 0) + (record.cachedWriteTokens ?? 0);
            spend.tokens += record.promptTokens + (record.completionTokens ?? 0);
          } else {
            spend.estimated = true;
            spend.inputTokens += estimateTokens(record.promptChars);
            spend.outputTokens += estimateTokens(record.replyChars);
            spend.tokens += record.estimatedTokens ?? estimateTokens(record.promptChars) + estimateTokens(record.replyChars);
          }
        }
        break;
      }
      case 'stop': {
        for (const spend of [of(record.agentId), on(record.model ?? record.agentId)]) {
          spend.turns++;
          if (!record.usage) continue;
          spend.counted++;
          spend.tokens += tokensOf(record.usage);
          spend.inputTokens += record.usage.inputTokens;
          spend.outputTokens += record.usage.outputTokens;
          spend.cachedTokens += (record.usage.cachedReadTokens ?? 0) + (record.usage.cachedWriteTokens ?? 0);
        }
        break;
      }
      case 'session_update':
        if (record.update.sessionUpdate === 'usage_update') {
          of(record.agentId).context = { used: record.update.used, size: record.update.size };
        }
        break;
      default:
        break;
    }
  }
  return { orchestrator, agents, models: [...models].map(([label, spend]) => ({ label, spend })) };
}

/** Approximate token count, on a character total. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * A token count at the width a roster line can afford: `850`, `4.1k`, `38k`,
 * `1.2M`. One decimal below ten thousand, since that is where a turn's
 * difference shows, and none above, where it does not.
 */
export function shortTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${trim(tokens / 1_000)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${trim(tokens / 1_000_000)}M`;
}

function trim(figure: number): string {
  return figure.toFixed(1).replace(/\.0$/, '');
}
