import { z } from 'zod';
import { extractJsonObject } from '../agents/json.js';

export const ActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('respond'),
    message: z.string(),
  }),
  z.object({
    action: z.literal('delegate'),
    agent: z.enum(['claude', 'gemini', 'codex']),
    task: z.string().min(1),
    done_when: z.string().optional(),
  }),
]);

export type Action = z.infer<typeof ActionSchema>;

/** Extract the first balanced top-level JSON object from free-form model text. */
export { extractJsonObject } from '../agents/json.js';

export type ParseResult =
  | { ok: true; action: Action }
  | { ok: false; error: string };

export function parseAction(text: string): ParseResult {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return { ok: false, error: 'No JSON object found in the reply.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  const result = ActionSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `JSON does not match the action schema: ${result.error.message}` };
  }
  return { ok: true, action: result.data };
}
