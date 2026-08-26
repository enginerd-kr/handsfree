import type { ChatClient } from './client.js';
import { extractJsonObject } from './json.js';
import { renderOutcome, type TaskOutcome } from '../orchestrator/outcome.js';

const SYSTEM = `You are handsfree, reporting back after delegated coding tasks have finished.

Write plain prose. No JSON, no code fences, no preamble.

Rules:
- Report what actually happened, task by task, in the past tense.
- Name the files that were created or changed.
- State refusals, failures and cancellations plainly. Never call a task done when its status says otherwise.
- Use only the facts you are given. Do not invent work, file names or outcomes.
- At most three sentences per task.`;

export interface NarrateInput {
  userMessage: string;
  outcomes: TaskOutcome[];
  notes: string[];
  workspaceDir: string;
}

/**
 * The turn always reports back. The model writes the prose when it can, and a
 * ledger built from the recorded outcomes stands in when it cannot — so a dead
 * endpoint or a cancelled turn can never be the reason the user hears nothing.
 */
export async function narrate(
  llm: ChatClient | undefined,
  input: NarrateInput,
  signal?: AbortSignal,
): Promise<string> {
  const ledger = renderLedger(input);
  if (!llm || signal?.aborted) return ledger;

  try {
    const reply = await llm.chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `The user asked:\n${input.userMessage}\n\nHere is exactly what happened:\n\n${ledger}\n\nReport back to the user.`,
        },
      ],
      { signal },
    );
    const prose = asProse(reply);
    return grounded(prose, input) ? prose : ledger;
  } catch {
    return ledger;
  }
}

/**
 * A small model asked to summarise sometimes answers the conversation instead
 * of the work — "Great! What's next?" after a task that created a file. A turn
 * that delegated must report what it delegated, so a summary that names neither
 * the agent nor anything it touched is discarded in favour of the ledger.
 */
function grounded(prose: string, input: NarrateInput): boolean {
  if (prose === '') return false;
  if (input.outcomes.length === 0) return true;

  const text = prose.toLowerCase();
  return input.outcomes.some((outcome) => {
    if (text.includes(outcome.agentId.toLowerCase())) return true;
    if (text.includes(outcome.status)) return true;
    return outcome.files.some((file) => text.includes(basename(file).toLowerCase()));
  });
}

function basename(file: string): string {
  return file.split('/').pop() ?? file;
}

export function renderLedger(input: NarrateInput): string {
  const lines = input.outcomes.map((outcome) => renderOutcome(outcome, input.workspaceDir));
  return [...lines, ...input.notes].join('\n\n').trim() || 'Nothing ran.';
}

/**
 * A model that has just spent a turn emitting JSON actions tends to answer a
 * prose request with one more action. That is not a summary, so it is discarded.
 */
function asProse(reply: string): string {
  const text = reply.trim();
  if (text === '') return '';
  if (!text.startsWith('{')) return text;
  const json = extractJsonObject(text);
  if (!json) return text;
  try {
    const parsed = JSON.parse(json) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message.trim() : '';
  } catch {
    return '';
  }
}
