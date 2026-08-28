/** One model an agent's session offers: the id it switches by, and its blurb. */
export interface ModelChoice {
  value: string;
  /** The agent's own description, shown beside the id and never in place of it. */
  description?: string;
}

/**
 * How a typed name is matched against an agent's roster: the id exactly, then
 * as a prefix, then anywhere in it. The tier is the score, lower being better;
 * nothing means the name is not on the roster at all. A bare query scores
 * everything alike, so a roster offered whole keeps the agent's own order.
 */
export function scoreModel(query: string, value: string): number | undefined {
  const wanted = query.toLowerCase();
  const id = value.toLowerCase();
  if (wanted === '') return 1;
  if (id === wanted) return 0;
  if (id.startsWith(wanted)) return 1;
  if (id.includes(wanted)) return 2;
  return undefined;
}

/**
 * The one model `wanted` names, the several it could be, or nothing. Only the
 * best tier counts: `flash` against `gemini-3.5-flash` and
 * `gemini-3.1-flash-lite` is two substring hits and an ambiguity, while `opus`
 * against `opus` and `opus[1m]` is the exact hit alone.
 */
export function matchModel<T extends { value: string }>(
  wanted: string,
  choices: readonly T[],
): T | T[] | undefined {
  let best: number | undefined;
  let hits: T[] = [];
  for (const choice of choices) {
    const score = scoreModel(wanted, choice.value);
    if (score === undefined) continue;
    if (best === undefined || score < best) {
      best = score;
      hits = [choice];
    } else if (score === best) {
      hits.push(choice);
    }
  }
  if (hits.length === 0) return undefined;
  return hits.length === 1 ? hits[0] : hits;
}

/**
 * The one model `wanted` names on a roster, or an error a person can act on.
 * Nothing and several are both answered with what the agent actually offers,
 * because someone who typed a name blind is asking what the names are.
 */
export function resolveModel<T extends { value: string }>(
  wanted: string,
  choices: readonly T[],
  who: string,
): T {
  const resolved = matchModel(wanted, choices);
  if (resolved === undefined) {
    throw new Error(
      `${who} offers no model matching "${wanted}". It offers: ` +
        `${choices.map((choice) => choice.value).join(', ')}.`,
    );
  }
  if (Array.isArray(resolved)) {
    throw new Error(
      `"${wanted}" could be any of ${resolved.map((c) => c.value).join(', ')} — ` +
        'say more of the name.',
    );
  }
  return resolved;
}
