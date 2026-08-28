import { z } from 'zod';
import { extractJsonObject, MessageStream } from './json.js';
import type { ChatClient, ChatMessage, JsonSchemaSpec } from './client.js';

export const StepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), message: z.string() }),
  z.object({
    action: z.literal('delegate'),
    agent: z.string().min(1),
    /**
     * What handsfree wants back. "answer" asks the agent to reply in words and
     * touch nothing; "change" asks it to change the workspace. Without this the
     * only delegation a planner can imagine is one that writes a file, and
     * "ask claude what it thinks" becomes "create thoughts.txt".
     */
    kind: z.enum(['answer', 'change']).default('change'),
    task: z.string().min(1),
    done_when: z.string().optional(),
  }),
]);
export type Step = z.infer<typeof StepSchema>;

/** Handed to endpoints that can constrain a reply to a schema. */
export const STEP_SCHEMA: JsonSchemaSpec = {
  name: 'handsfree_step',
  schema: z.toJSONSchema(StepSchema) as Record<string, unknown>,
};

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
  /** What the agent is for: its configured role, or the launch profile's note. */
  description: string;
}

/**
 * The planner's standing instructions, with the run so far under them. The
 * run state is the planner's memory of what was delegated: the exchanges that
 * carried each task are dropped once the turn is over, and this is what stays.
 */
export function planSystemPrompt(agents: AgentCard[], workspace: string, runState = ''): string {
  const roster = agents.map((agent) => `- "${agent.id}": ${agent.description}`).join('\n');
  const first = agents[0]?.id ?? 'claude';
  const memory = runState
    ? `\n\nTasks so far this run (the full record — earlier messages may have been dropped):\n${runState}`
    : '';
  return `You are handsfree. You either answer the user yourself or hand one task to one agent.

Agents:
${roster}

How the agents work:
- They share a workspace directory: ${workspace}. Everything they create lives there.
- Every file they touch and every command they run is approved or refused by handsfree, not by them. A refusal is final; asking again will not change it.
- Each agent keeps its memory between tasks, so a follow-up task can refer to what it just did.
- Each agent is told which files the other agents changed since it last worked, and what they said they did. A brief need not repeat that.
- They can also just talk. Asking one a question is a task; its reply comes back to you.

Your rules:
- Delegate work that needs an agent: changing files or code, and anything the user wants a specific agent to say. Answer directly for questions about yourself, and for conversation.
- Every delegation says what you want back:
  - "answer" — you want the agent's words. It creates nothing. Use this whenever the user says ask, tell, question, or wants an agent's opinion.
  - "change" — you want the workspace changed.
- Never invent a file. Name a file only when the user named one or clearly asked for one. A question is not a file.
- One task per reply. Write it as a short imperative brief, with exact file names and exact content when the user gave them.
- After a task finishes you are told what actually happened, including what the agent said. Relay the agent's answer to the user. If it failed or was refused, say so — never report work that did not happen.
- Reply with EXACTLY ONE JSON object and nothing else:
{"action":"answer","message":"<what you tell the user>"}
{"action":"delegate","agent":"<agent id>","kind":"answer|change","task":"<imperative brief>","done_when":"<observable success condition>"}

Examples:
User: hello
{"action":"answer","message":"Hi — tell me what you'd like built and I'll route it."}
User: make notes.txt containing hello world
{"action":"delegate","agent":"${first}","kind":"change","task":"Create notes.txt containing exactly: hello world","done_when":"notes.txt exists with that content"}
User: ask ${first} 안녕?
{"action":"delegate","agent":"${first}","kind":"answer","task":"안녕?","done_when":"you have replied"}
User: what does ${first} think of this approach?
{"action":"delegate","agent":"${first}","kind":"answer","task":"What do you think of this approach?","done_when":"you have given your view"}${memory}`;
}

/**
 * Where a would-be answer's text goes while the model is still writing it.
 * The step may yet turn out to be a delegation or unusable JSON, so whatever
 * was shown must be retractable.
 */
export interface AnswerStream {
  delta(text: string): void;
  retract(): void;
}

/** Asks for one step, correcting the model in place when its JSON is unusable. */
export async function nextStep(
  llm: ChatClient,
  messages: ChatMessage[],
  agents: string[],
  signal: AbortSignal,
  stream?: AnswerStream,
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
    // A fresh extractor per attempt: a retried reply starts a new JSON object.
    const message = stream ? new MessageStream() : undefined;
    const onDelta = message
      ? (text: string) => {
          const decoded = message.push(text);
          if (decoded !== '') stream!.delta(decoded);
        }
      : undefined;
    let reply: string;
    try {
      reply = await llm.chat(prompt, { schema: STEP_SCHEMA, signal, onDelta });
    } catch (err) {
      stream?.retract();
      throw err;
    }
    last = parseStep(reply, agents);
    if (last.ok) return last;
    // Whatever streamed came from a reply that could not be used.
    stream?.retract();
  }
  return last;
}
