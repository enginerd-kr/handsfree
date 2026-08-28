/**
 * "@agent" mentions. An at-sign opens a name the way a slash opens a command:
 * typed at the start of a word it offers the agents it could become, and a
 * line that leads with one is sent to that agent rather than to the planner.
 * A colon after the name picks the model too: `@claude:opus` is Claude, asked
 * to be Opus for the work.
 *
 * Everything here counts in code points, the same currency as the prompt's
 * cursor, so a mention sitting after an emoji is still measured true. A name
 * is ASCII — letters, digits, hyphen, underscore — which is also what keeps
 * an email address or a Korean sentence from ever reading as one.
 */

import { scoreModel } from '../host/models.js';

/** The characters an agent id is spelled with. */
const NAME_CHAR = /[A-Za-z0-9_-]/;

/**
 * A model id's characters: a name's, plus the dots version strings carry and
 * the brackets a variant is spelled with — claude-agent-acp advertises
 * `opus[1m]` for the long-context Opus, codex `gpt-5.6-terra[max]` for a
 * reasoning effort. An id handsfree cannot spell is an id nobody can type.
 */
const MODEL_CHAR = /[A-Za-z0-9._[\]-]/;

/** Where a known agent's mention sits in a line, in code points, end exclusive. */
export interface MentionSpan {
  start: number;
  end: number;
  /** The id as the config spells it, whatever case was typed. */
  agent: string;
  /** The model a `:model` suffix asked for, as typed. */
  model?: string;
}

/**
 * The half-written mention the cursor is inside, if it is inside one: the
 * index of its `@` and whatever name has been typed so far. An at-sign only
 * opens a mention at the start of a word — mid-word it is an email address or
 * a decorator, and neither wants a menu.
 */
export function mentionTokenAt(
  value: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const chars = [...value];
  let at = Math.min(cursor, chars.length);
  while (at > 0 && NAME_CHAR.test(chars[at - 1]!)) at--;
  if (chars[at - 1] !== '@') return undefined;
  const start = at - 1;
  if (start > 0 && !/\s/.test(chars[start - 1]!)) return undefined;
  return { start, query: chars.slice(at, cursor).join('') };
}

/**
 * The agents a half-written mention could still become, best first. A bare
 * `@` offers everyone: the sign was the question, and the list is the answer.
 * Prefix before substring, for the same reason the command menu scores that
 * way — a list that reorders under the hands cannot be aimed at.
 */
export function suggestAgents(
  value: string,
  cursor: number,
  agents: readonly string[],
): string[] {
  const token = mentionTokenAt(value, cursor);
  if (!token) return [];
  const wanted = token.query.toLowerCase();

  const scored: { agent: string; score: number }[] = [];
  for (const agent of agents) {
    const name = agent.toLowerCase();
    let score: number;
    if (wanted === '') score = 1;
    else if (name === wanted) score = 0;
    else if (name.startsWith(wanted)) score = 1;
    else if (name.includes(wanted)) score = 2;
    else continue;
    scored.push({ agent, score });
  }

  return scored
    .sort(
      (a, b) =>
        a.score - b.score || a.agent.length - b.agent.length || a.agent.localeCompare(b.agent),
    )
    .map((entry) => entry.agent);
}

/**
 * A chosen agent written into the draft: the token the cursor was in — its
 * `@` included — becomes `@name` and the cursor lands right after it, with
 * whatever sat beyond the cursor left exactly where it was. No space is added:
 * the next keystroke decides whether the address is finished (a space, and the
 * task begins) or still being aimed (a colon, and the model menu opens).
 */
export function completeMention(
  draft: { value: string; cursor: number },
  agent: string,
): { value: string; cursor: number } {
  const token = mentionTokenAt(draft.value, draft.cursor);
  if (!token) return draft;
  const chars = [...draft.value];
  const filled = [...`@${agent}`];
  const value = [...chars.slice(0, token.start), ...filled, ...chars.slice(draft.cursor)].join('');
  return { value, cursor: token.start + filled.length };
}

/**
 * The half-written model the cursor is inside: `@agent:mo` with the cursor in
 * the part after the colon. Only a name that resolves opens a selector — a
 * colon after anything else is the ordinary punctuation it always was.
 */
export function modelTokenAt(
  value: string,
  cursor: number,
  agents: readonly string[],
): { start: number; agent: string; query: string } | undefined {
  const chars = [...value];
  let at = Math.min(cursor, chars.length);
  while (at > 0 && MODEL_CHAR.test(chars[at - 1]!)) at--;
  if (chars[at - 1] !== ':') return undefined;
  const colon = at - 1;
  let nameStart = colon;
  while (nameStart > 0 && NAME_CHAR.test(chars[nameStart - 1]!)) nameStart--;
  if (chars[nameStart - 1] !== '@') return undefined;
  const start = nameStart - 1;
  if (start > 0 && !/\s/.test(chars[start - 1]!)) return undefined;
  const name = chars.slice(nameStart, colon).join('').toLowerCase();
  const agent = agents.find((id) => id.toLowerCase() === name);
  if (!agent) return undefined;
  return { start, agent, query: chars.slice(at, cursor).join('') };
}

/**
 * The models a half-written `:model` could still become, best first: the
 * agent's roster scored the way agents are — exact, then prefix, then
 * substring — so the list holds still under the hands. Within a tier the
 * agent's own order stands: the sort is stable and adds no tiebreak of its
 * own, and a bare `:` shows the roster exactly as it was advertised.
 */
export function suggestModels<T extends { value: string }>(
  query: string,
  choices: readonly T[],
): T[] {
  return choices
    .map((choice) => ({ choice, score: scoreModel(query, choice.value) }))
    .filter((entry): entry is { choice: T; score: number } => entry.score !== undefined)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.choice);
}

/**
 * A chosen model written into the draft: the whole address the cursor was in
 * becomes `@agent:model ` — the space this time, because nothing more of the
 * address is left to spell — with the tail beyond the cursor kept in place.
 */
export function completeModel(
  draft: { value: string; cursor: number },
  agents: readonly string[],
  model: string,
): { value: string; cursor: number } {
  const token = modelTokenAt(draft.value, draft.cursor, agents);
  if (!token) return draft;
  const chars = [...draft.value];
  const filled = [...`@${token.agent}:${model} `];
  const value = [...chars.slice(0, token.start), ...filled, ...chars.slice(draft.cursor)].join('');
  return { value, cursor: token.start + filled.length };
}

/**
 * Every completed mention of a configured agent in a line. Only a name that
 * resolves earns a span: `@gemini` wears Gemini's colour, and `@geminix` or a
 * typo stays the plain text it is — the colour is what says the routing will
 * actually happen. A `:model` suffix rides along inside the span, so the whole
 * address is painted as the one token it is.
 */
export function mentionSpans(value: string, agents: readonly string[]): MentionSpan[] {
  const chars = [...value];
  const spans: MentionSpan[] = [];
  for (let at = 0; at < chars.length; at++) {
    if (chars[at] !== '@') continue;
    if (at > 0 && !/\s/.test(chars[at - 1]!)) continue;
    let end = at + 1;
    while (end < chars.length && NAME_CHAR.test(chars[end]!)) end++;
    const name = chars.slice(at + 1, end).join('').toLowerCase();
    const agent = agents.find((id) => id.toLowerCase() === name);
    if (agent) {
      let close = end;
      if (chars[close] === ':') {
        let stop = close + 1;
        while (stop < chars.length && MODEL_CHAR.test(chars[stop]!)) stop++;
        if (stop > close + 1) {
          const model = chars.slice(close + 1, stop).join('');
          spans.push({ start: at, end: stop, agent, model });
          at = stop - 1;
          continue;
        }
      }
      spans.push({ start: at, end, agent });
    }
    at = end - 1;
  }
  return spans;
}

/**
 * A line that leads with a mention, split into who it names, the model it
 * asks that agent to be, and what it asks for. Conservative on purpose, the
 * way `@file` references are: a name that is not a configured agent, a colon
 * with no model behind it, or a mention with nothing after it, is not a
 * routing — the line goes to the planner as the ordinary text it is.
 */
export function parseMention(
  text: string,
  agents: readonly string[],
): { agent: string; model?: string; task: string } | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('@')) return undefined;
  const rest = trimmed.slice(1);
  const gap = rest.search(/\s/);
  const token = gap === -1 ? rest : rest.slice(0, gap);
  const colon = token.indexOf(':');
  const name = colon === -1 ? token : token.slice(0, colon);
  const model = colon === -1 ? undefined : token.slice(colon + 1);
  if (name === '' || /[^A-Za-z0-9_-]/.test(name)) return undefined;
  // Read through MODEL_CHAR rather than a second literal, so the spelling the
  // menu completes and the spelling a sent line parses cannot drift apart.
  if (model !== undefined && (model === '' || ![...model].every((c) => MODEL_CHAR.test(c)))) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  const agent = agents.find((id) => id.toLowerCase() === wanted);
  if (!agent) return undefined;
  const task = gap === -1 ? '' : rest.slice(gap + 1).trim();
  if (task === '') return undefined;
  return model === undefined ? { agent, task } : { agent, model, task };
}
