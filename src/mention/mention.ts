/**
 * "@agent" mentions. An at-sign opens a name the way a slash opens a command:
 * typed at the start of a word it offers the agents it could become, and a
 * line that leads with one is sent to that agent rather than to the planner.
 *
 * Everything here counts in code points, the same currency as the prompt's
 * cursor, so a mention sitting after an emoji is still measured true. A name
 * is ASCII — letters, digits, hyphen, underscore — which is also what keeps
 * an email address or a Korean sentence from ever reading as one.
 */

/** The characters an agent id is spelled with. */
const NAME_CHAR = /[A-Za-z0-9_-]/;

/** Where a known agent's mention sits in a line, in code points, end exclusive. */
export interface MentionSpan {
  start: number;
  end: number;
  /** The id as the config spells it, whatever case was typed. */
  agent: string;
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
 * `@` included — becomes `@name ` and the cursor lands after the space, with
 * whatever sat beyond the cursor left exactly where it was.
 */
export function completeMention(
  draft: { value: string; cursor: number },
  agent: string,
): { value: string; cursor: number } {
  const token = mentionTokenAt(draft.value, draft.cursor);
  if (!token) return draft;
  const chars = [...draft.value];
  const filled = [...`@${agent} `];
  const value = [...chars.slice(0, token.start), ...filled, ...chars.slice(draft.cursor)].join('');
  return { value, cursor: token.start + filled.length };
}

/**
 * Every completed mention of a configured agent in a line. Only a name that
 * resolves earns a span: `@gemini` wears Gemini's colour, and `@geminix` or a
 * typo stays the plain text it is — the colour is what says the routing will
 * actually happen.
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
    if (agent) spans.push({ start: at, end, agent });
    at = end - 1;
  }
  return spans;
}

/**
 * A line that leads with a mention, split into who it names and what it asks.
 * Conservative on purpose, the way `@file` references are: a name that is not
 * a configured agent, or a mention with nothing after it, is not a routing —
 * the line goes to the planner as the ordinary text it is.
 */
export function parseMention(
  text: string,
  agents: readonly string[],
): { agent: string; task: string } | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('@')) return undefined;
  const rest = trimmed.slice(1);
  const gap = rest.search(/\s/);
  const name = gap === -1 ? rest : rest.slice(0, gap);
  if (name === '' || /[^A-Za-z0-9_-]/.test(name)) return undefined;
  const wanted = name.toLowerCase();
  const agent = agents.find((id) => id.toLowerCase() === wanted);
  if (!agent) return undefined;
  const task = gap === -1 ? '' : rest.slice(gap + 1).trim();
  if (task === '') return undefined;
  return { agent, task };
}
