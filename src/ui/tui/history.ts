/**
 * The prompt's memory: everything sent this run, and the arrows that walk back
 * through it.
 *
 * A line that has been sent is gone from the prompt but rarely done with — it
 * is retyped with a word changed, or sent again at another agent. Up steps one
 * line further back, down comes forward again, and the far end of the way
 * forward is whatever was half-written when the walk began, handed back
 * untouched.
 *
 * The walk is only ever a way of reading: an edit ends it, and the text that
 * was recalled becomes the draft it now is. Nothing here reaches the
 * transcript — this is what the user typed, not what the run did.
 */

/** Which way an arrow goes: `back` into what was sent, `forward` towards the draft. */
export type Step = 'back' | 'forward';

export interface History {
  /** What has been sent, oldest first. */
  readonly entries: readonly string[];
  /**
   * How far back the prompt is looking: 0 is the draft being written, 1 the
   * line sent last, `entries.length` the first line of the run.
   */
  readonly at: number;
  /** What was being typed when the walk began, kept for the way home. */
  readonly pending: string;
}

/** A run with nothing sent yet. */
export const NOTHING_SENT: History = { entries: [], at: 0, pending: '' };

/**
 * Takes a sent line into the memory and ends any walk. A line that repeats the
 * one before it is not kept twice: sending the same thing again is one line as
 * far as the arrows are concerned, and two would only cost a keypress to get
 * past.
 */
export function remember(history: History, text: string): History {
  const last = history.entries[history.entries.length - 1];
  const entries = text === '' || text === last ? history.entries : [...history.entries, text];
  return { entries, at: 0, pending: '' };
}

/**
 * Ends the walk without moving the prompt: what the arrows recalled has been
 * edited, so it is a draft of its own now and the next `back` starts over from
 * the newest line.
 */
export function settle(history: History): History {
  return history.at === 0 ? history : { ...history, at: 0, pending: '' };
}

/**
 * One step of the walk, or nothing when there is nowhere to go — the oldest
 * line is already up, or the prompt is already holding the draft. `typed` is
 * what the prompt holds now: on the first step back it is what the walk will
 * come home to.
 */
export function recall(
  history: History,
  typed: string,
  step: Step,
): { history: History; value: string } | undefined {
  const at = step === 'back' ? history.at + 1 : history.at - 1;
  if (at < 0 || at > history.entries.length) return undefined;
  const pending = history.at === 0 ? typed : history.pending;
  const value = at === 0 ? pending : history.entries[history.entries.length - at]!;
  return { history: { ...history, at, pending }, value };
}
