import { MessageStream } from './json.js';
import type { ChatClient, ChatMessage } from './client.js';
import type { ParsedStep, Toolbox } from '../tools/tool.js';

export type { ParsedStep, Step } from '../tools/tool.js';

/** The line between the run state and the user's own words, in a message that carries both. */
export const STATE_DIVIDER = '---';

/**
 * The planner's standing instructions. Nothing in here changes during a run:
 * the tools are the toolbox's, the rules are the rules, and what has happened
 * since is carried separately, in the run state — so an endpoint that caches a
 * prompt by its prefix gets to keep this one.
 *
 * The frame says only what is true of every reply: answer, or call one tool.
 * What each tool is for, and how to call it well, is the tool's own to say,
 * at the foot — so a tool added to the box is a tool the planner knows.
 */
export function planSystemPrompt(toolbox: Toolbox): string {
  return `You are handsfree. Each reply is one of two things: an answer to the user, or one call to one tool.

What you are told:
- A user message may open with a RUN STATE block and a line of three dashes. The block is the run so far — every task, what each agent said it did, what each agent's session holds, the files changed — and is the full record; earlier messages may have been dropped. A follow-up to something an agent said builds on the "said" line of its task. The user's own words are what follows the dashes.
- After a call finishes you get a TOOL RESULT: what the tool reports back.

Your rules:
- Answer directly for questions about yourself, and for conversation. Call a tool for what a tool is for.
- A short line from the user — "yes", "ok", "응", "go on" — answers the last question you asked, or accepts the last thing you offered. Do what that question was about, or say what you need to; never answer it with a greeting or an invitation to ask.
- One call per reply. After a call finishes, tell the user in a sentence or two what became of it, from the result. If it failed or was refused, say so — never report work that did not happen.
- Reply with EXACTLY ONE JSON object and nothing else:
{"action":"answer","message":"<what you tell the user>"}
{"action":"call","tool":"<tool name>","input":{<that tool's input>}}

Example:
User: hello
{"action":"answer","message":"Hi — tell me what you'd like built and I'll route it."}

Tools:
${toolbox.describe()}`;
}

export interface SessionLine {
  id: string;
  /** What the session holds, as `renderAgentRecord` says it. */
  record: string;
}

/**
 * The run so far, for the head of the user's message: what each agent's
 * session is holding, and the ledger of tasks. It goes at the end of the
 * prompt rather than the start because it is what changes, and because the
 * end is where a model's attention is when it decides — the plan recited
 * where it will be read.
 */
export function renderState(sessions: SessionLine[], runState: string): string {
  const held = sessions.filter((session) => session.record !== '');
  if (held.length === 0 && runState === '') return '';
  const lines = ['RUN STATE'];
  if (held.length > 0) {
    lines.push('Agent sessions:');
    for (const session of held) lines.push(`- ${session.id}: ${session.record}`);
  }
  if (runState !== '') {
    lines.push('Tasks so far:', runState);
  }
  return lines.join('\n');
}

/** The user's line with the run state ahead of it, or the line alone when there is none. */
export function composeUserMessage(state: string, prompt: string): string {
  return state === '' ? prompt : `${state}\n${STATE_DIVIDER}\n${prompt}`;
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
  toolbox: Toolbox,
  signal: AbortSignal,
  stream?: AnswerStream,
  attempts = 3,
): Promise<ParsedStep> {
  let last: ParsedStep = { ok: false, error: 'no reply' };
  const schema = toolbox.jsonSchema();
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
      reply = await llm.chat(prompt, { schema, signal, onDelta });
    } catch (err) {
      stream?.retract();
      throw err;
    }
    last = toolbox.parse(reply);
    if (last.ok) return last;
    // Whatever streamed came from a reply that could not be used.
    stream?.retract();
  }
  return last;
}
