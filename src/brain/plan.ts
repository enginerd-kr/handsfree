import { z } from 'zod';
import { extractJsonObject } from './json.js';
import type { ChatClient, ChatMessage } from './client.js';

export const StepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), message: z.string() }),
  z.object({
    action: z.literal('delegate'),
    agent: z.string().min(1),
    task: z.string().min(1),
    done_when: z.string().optional(),
  }),
]);
export type Step = z.infer<typeof StepSchema>;

export type ParsedStep = { ok: true; step: Step } | { ok: false; error: string };

export function parseStep(text: string, agents: string[]): ParsedStep {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, error: 'No JSON object in the reply.' };

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }

  const parsed = StepSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `Does not match the schema: ${parsed.error.issues[0]?.message}` };
  }
  if (parsed.data.action === 'delegate' && !agents.includes(parsed.data.agent)) {
    return {
      ok: false,
      error: `"${parsed.data.agent}" is not an available agent. Available: ${agents.join(', ')}.`,
    };
  }
  return { ok: true, step: parsed.data };
}

export interface AgentCard {
  id: string;
  /** What the agent said it is, once connected; falls back to the config note. */
  description: string;
}

export function planSystemPrompt(agents: AgentCard[], workspace: string): string {
  const roster = agents.map((agent) => `- "${agent.id}": ${agent.description}`).join('\n');
  return `You are handsfree. You either answer the user yourself or hand one coding task to one agent.

Agents:
${roster}

How the agents work:
- They share a workspace directory: ${workspace}. Everything they create lives there.
- Every file they touch and every command they run is approved or refused by handsfree, not by them. A refusal is final; asking again will not change it.
- Each agent keeps its memory between tasks, so a follow-up task can refer to what it just did.

Your rules:
- Delegate anything that creates or changes files or code. Answer directly for questions, explanations and conversation.
- One task per reply. Write it as a short imperative brief, with exact file names and exact content when the user gave them.
- After a task finishes you are told what actually happened. If it failed or was refused, say so — never report work that did not happen.
- Reply with EXACTLY ONE JSON object and nothing else:
{"action":"answer","message":"<what you tell the user>"}
{"action":"delegate","agent":"<agent id>","task":"<imperative brief>","done_when":"<observable success condition>"}

Examples:
User: hello
{"action":"answer","message":"Hi — tell me what you'd like built and I'll route it."}
User: make notes.txt containing hello world
{"action":"delegate","agent":"${agents[0]?.id ?? 'claude'}","task":"Create notes.txt containing exactly: hello world","done_when":"notes.txt exists with that content"}`;
}

/** Asks for one step, correcting the model in place when its JSON is unusable. */
export async function nextStep(
  llm: ChatClient,
  messages: ChatMessage[],
  agents: string[],
  signal: AbortSignal,
  attempts = 3,
): Promise<ParsedStep> {
  let last: ParsedStep = { ok: false, error: 'no reply' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt =
      attempt === 0
        ? messages
        : [
            ...messages,
            {
              role: 'user' as const,
              content: `That reply was unusable: ${last.ok ? '' : last.error} Reply with ONLY one JSON object matching the schema.`,
            },
          ];
    const reply = await llm.chat(prompt, { json: true, signal });
    last = parseStep(reply, agents);
    if (last.ok) return last;
  }
  return last;
}
