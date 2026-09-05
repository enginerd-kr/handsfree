import { ORCHESTRATOR } from '../../contracts/identity.js';
/**
 * "@agent" mentions. An at-sign opens a name the way a slash opens a command:
 * typed at the start of a word it offers the agents it could become, and a
 * line that leads with one is sent to that agent rather than to the planner.
 * A colon after the name picks the model too: `@claude:opus` is Claude, asked
 * to be Opus for the work.
 *
 * One name is not an agent: `@orchestrator` is the planner itself, and what
 * follows its colon is the agent it plans through — `@orchestrator:claude:opus`
 * moves the planner to Claude on Opus. It is the same address one segment
 * longer, so it is read by the same tokenizer rather than a grammar of its own.
 *
 * Everything here counts in code points, the same currency as the prompt's
 * cursor, so a mention sitting after an emoji is still measured true. A name
 * is ASCII — letters, digits, hyphen, underscore — which is also what keeps
 * an email address or a Korean sentence from ever reading as one.
 */

import { scoreModel } from '../../host/models.js';

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
 * The address the cursor is inside, split at its colons: `@claude:opu` is two
 * segments and `@orchestrator:claude:opu` is three. Reading the whole address
 * at once is what lets the same colon mean a model after an agent and an agent
 * after the planner — which of them is being typed is the last segment, and
 * what came before it says what it is.
 *
 * An at-sign only opens an address at the start of a word: mid-word it is an
 * email address or a decorator, and neither wants a menu.
 */
function addressAt(
  value: string,
  cursor: number,
): { start: number; segments: string[] } | undefined {
  const chars = [...value];
  const end = Math.min(cursor, chars.length);
  let at = end;
  while (at > 0 && (MODEL_CHAR.test(chars[at - 1]!) || chars[at - 1] === ':')) at--;
  if (chars[at - 1] !== '@') return undefined;
  const start = at - 1;
  if (start > 0 && !/\s/.test(chars[start - 1]!)) return undefined;
  return { start, segments: chars.slice(at, end).join('').split(':') };
}

const isOrchestrator = (name: string | undefined): boolean =>
  name?.toLowerCase() === ORCHESTRATOR;

/**
 * The half-written name the cursor is inside, if it is inside one: the index
 * of its `@` and whatever has been typed so far. Only the first segment is a
 * name — behind a colon the address has moved on to what the name chose.
 */
export function mentionTokenAt(
  value: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const address = addressAt(value, cursor);
  if (!address || address.segments.length !== 1) return undefined;
  return { start: address.start, query: address.segments[0]! };
}

/**
 * The half-written agent the cursor is inside when the address is the
 * planner's: `@orchestrator:cla`. The segment is an agent id rather than a
 * model, which is the whole reason the planner's address is read apart.
 */
export function plannerTokenAt(
  value: string,
  cursor: number,
): { start: number; query: string } | undefined {
  const address = addressAt(value, cursor);
  if (!address || address.segments.length !== 2) return undefined;
  if (!isOrchestrator(address.segments[0])) return undefined;
  return { start: address.start, query: address.segments[1]! };
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
  // A name in the first segment could still become the planner, and one after
  // `@orchestrator:` could only ever be an agent — the planner cannot plan
  // through itself.
  const named = mentionTokenAt(value, cursor);
  const planner = named ? undefined : plannerTokenAt(value, cursor);
  const token = named ?? planner;
  if (!token) return [];
  const candidates = planner ? agents : [...agents, ORCHESTRATOR];
  const wanted = token.query.toLowerCase();

  const scored: { agent: string; score: number }[] = [];
  for (const agent of candidates) {
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
  const named = mentionTokenAt(draft.value, draft.cursor);
  const planner = named ? undefined : plannerTokenAt(draft.value, draft.cursor);
  const token = named ?? planner;
  if (!token) return draft;
  const chars = [...draft.value];
  // The planner's address keeps its head: what is being filled in is the agent
  // behind the colon, not the name in front of it.
  const filled = [...(planner ? `@${ORCHESTRATOR}:${agent}` : `@${agent}`)];
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
  const address = addressAt(value, cursor);
  if (!address) return undefined;
  const segments = address.segments;
  // The model is the last segment of either address: `@agent:model`, or
  // `@orchestrator:agent:model` where the planner named the agent first.
  const pair =
    segments.length === 2 && !isOrchestrator(segments[0])
      ? [segments[0]!, segments[1]!]
      : segments.length === 3 && isOrchestrator(segments[0])
        ? [segments[1]!, segments[2]!]
        : undefined;
  if (!pair) return undefined;
  const name = pair[0]!.toLowerCase();
  const agent = agents.find((id) => id.toLowerCase() === name);
  if (!agent) return undefined;
  return { start: address.start, agent, query: pair[1]! };
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
  const address = addressAt(draft.value, draft.cursor);
  if (!token || !address) return draft;
  const chars = [...draft.value];
  const head = address.segments.length === 3 ? `@${ORCHESTRATOR}:` : '@';
  const filled = [...`${head}${token.agent}:${model} `];
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
  /** The name that starts at `from`, and where it ends. */
  const nameAt = (from: number): { name: string; end: number } => {
    let end = from;
    while (end < chars.length && NAME_CHAR.test(chars[end]!)) end++;
    return { name: chars.slice(from, end).join(''), end };
  };
  /** The model behind a colon at `from`, where there is a colon and a model. */
  const modelAt = (from: number): { model: string; end: number } | undefined => {
    if (chars[from] !== ':') return undefined;
    let end = from + 1;
    while (end < chars.length && MODEL_CHAR.test(chars[end]!)) end++;
    return end > from + 1 ? { model: chars.slice(from + 1, end).join(''), end } : undefined;
  };

  for (let at = 0; at < chars.length; at++) {
    if (chars[at] !== '@') continue;
    if (at > 0 && !/\s/.test(chars[at - 1]!)) continue;
    const head = nameAt(at + 1);
    // The planner's address is painted only once it names an agent: until then
    // `@orchestrator` has moved nothing, and the colour is what says it will.
    if (isOrchestrator(head.name)) {
      if (chars[head.end] !== ':') {
        at = head.end - 1;
        continue;
      }
      const named = nameAt(head.end + 1);
      const agent = agents.find((id) => id.toLowerCase() === named.name.toLowerCase());
      if (!agent) {
        at = named.end - 1;
        continue;
      }
      const model = modelAt(named.end);
      spans.push(
        model
          ? { start: at, end: model.end, agent, model: model.model }
          : { start: at, end: named.end, agent },
      );
      at = (model?.end ?? named.end) - 1;
      continue;
    }
    const agent = agents.find((id) => id.toLowerCase() === head.name.toLowerCase());
    if (agent) {
      const model = modelAt(head.end);
      if (model) {
        spans.push({ start: at, end: model.end, agent, model: model.model });
        at = model.end - 1;
        continue;
      }
      spans.push({ start: at, end: head.end, agent });
    }
    at = head.end - 1;
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
  // Several named participants need the orchestrator to choose how their work
  // relates; a leading name must not claim the whole multi-agent request.
  if (mentionSpans(trimmed, agents).some((span) => span.agent !== agent)) return undefined;
  const task = gap === -1 ? '' : rest.slice(gap + 1).trim();
  if (task === '') return undefined;
  return model === undefined ? { agent, task } : { agent, model, task };
}

/**
 * A line that leads with `@orchestrator:agent[:model]`, split into the agent
 * that should plan, the model it should plan on, and whatever else the line
 * asked for. Unlike an agent mention this is not conservative about the name:
 * `@orchestrator:` is unmistakably an attempt to move the planner, so an agent
 * that does not exist travels through as typed and is answered with an error,
 * rather than being sent to the planner as if it were prose.
 */
export function parseOrchestration(
  text: string,
  agents: readonly string[],
): { agent: string; model?: string; rest: string } | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('@')) return undefined;
  const after = trimmed.slice(1);
  const gap = after.search(/\s/);
  const token = gap === -1 ? after : after.slice(0, gap);
  const segments = token.split(':');
  if (!isOrchestrator(segments[0]) || segments.length < 2 || segments.length > 3) return undefined;
  const name = segments[1]!;
  const model = segments[2];
  if (name === '' || /[^A-Za-z0-9_-]/.test(name)) return undefined;
  if (model !== undefined && (model === '' || ![...model].every((c) => MODEL_CHAR.test(c)))) {
    return undefined;
  }
  // A name that resolves is spelled the way the config spells it; one that
  // does not is kept as typed, so the error can name what was actually asked for.
  const agent = agents.find((id) => id.toLowerCase() === name.toLowerCase()) ?? name;
  const rest = gap === -1 ? '' : after.slice(gap + 1).trim();
  return model === undefined ? { agent, rest } : { agent, model, rest };
}
