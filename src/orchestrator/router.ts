import { z } from 'zod';
import { estimateTokens, fitBudget } from '../brain/client.js';
import { extractJsonObject } from '../brain/json.js';

/** The same bounded wire contract is used by execution and live router evaluations. */
export function routingRequest(candidates: readonly { agent: string; description: string }[], task: string, contextTokens: number) {
  if (!candidates.length) throw new Error('Routing needs at least one candidate');
  // Neutral IDs avoid a small model choosing by brand associations instead of configured roles.
  const entries = candidates.map((candidate, index) => ({ agent: String(index), description: candidate.description }));
  const result = z.object({ agent: z.enum(entries.map((c) => c.agent) as [string, ...string[]]) });
  const schema = { name: 'handsfree_route', schema: z.toJSONSchema(result) as Record<string, unknown> };
  const maxOutputTokens = 64;
  const messages = fitBudget([
    { role: 'system', content: 'Select the role that best matches the task. Return only {"agent":"id"}. Do not rewrite the task.\n'
      + JSON.stringify(entries) },
    { role: 'user', content: task, pinned: true },
  ], contextTokens - maxOutputTokens - estimateTokens(JSON.stringify(schema.schema)) - 64);
  return { messages, schema, maxOutputTokens, parse(reply: string): string | undefined {
    try { const parsed = result.safeParse(JSON.parse(extractJsonObject(reply) ?? '{}')); return parsed.success ? candidates[Number(parsed.data.agent)]?.agent : undefined; }
    catch { return undefined; }
  } };
}
