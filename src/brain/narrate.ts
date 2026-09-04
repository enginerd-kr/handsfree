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
export interface Narration {
  text: string;
  /** True when the text is the ledger, not prose: the model was unreachable or unusable. */
  ledger: boolean;
}

export async function narrate(
  llm: ChatClient | undefined,
  input: NarrateInput,
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<Narration> {
  const ledger = renderLedger(input);
  if (!llm || signal?.aborted) return { text: ledger, ledger: true };

  try {
    const reply = await llm.chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `The user asked:\n${input.userMessage}\n\nHere is exactly what happened:\n\n${ledger}\n\nReport back to the user.`,
        },
      ],
      { signal, onDelta: onDelta ? proseGate(onDelta) : undefined },
    );
    const prose = asProse(reply);
    return grounded(prose, input) ? { text: prose, ledger: false } : { text: ledger, ledger: true };
  } catch {
    return { text: ledger, ledger: true };
  }
}

/**
 * Streams the reply only once it is clearly prose. A model that opens with `{`
 * or a code fence is emitting one more JSON action, which asProse below will
 * unwrap or discard — so nothing is shown until the finished reply settles it.
 */
function proseGate(onDelta: (text: string) => void): (text: string) => void {
  let buffer = '';
  let mode: 'buffering' | 'stream' | 'silent' = 'buffering';
  return (text) => {
    if (mode === 'silent') return;
    if (mode === 'stream') {
      onDelta(text);
      return;
    }
    buffer += text;
    const first = buffer.trimStart()[0];
    if (first === undefined) return;
    if (first === '{' || first === '`') {
      mode = 'silent';
      return;
    }
    mode = 'stream';
    onDelta(buffer);
  };
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
    if (outcome.files.some((file) => text.includes(basename(file).toLowerCase()))) return true;
    // A summary that names none of those may still be about the work: "the
    // tests were run and all nine passed" says nothing of claude, of "done"
    // or of a file, and is a true account of a task that ran a command. It
    // is kept when it shares the task's own words — two of the longer ones,
    // from the brief or the agent's summary, so that "Great! What's next?"
    // still shares none.
    const shared = new Set<string>();
    for (const word of contentWords(`${outcome.task} ${outcome.report.summary}`)) {
      if (text.includes(word)) shared.add(word);
    }
    return shared.size >= 2;
  });
}

/** The words of a text worth matching on: five letters or more, lowercased, once each. */
function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9가-힣]+/)) {
    if (word.length >= 5) words.add(word);
  }
  return words;
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
