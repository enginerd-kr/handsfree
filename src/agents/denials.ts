const DENIAL_PATTERNS: RegExp[] = [
  /permission[^.\n]{0,40}(denied|not granted)/i,
  /(denied|blocked)[^.\n]{0,40}permission/i,
  /requires? (user )?approval/i,
  /approval (was )?(required|denied|requested)/i,
  /not (allowed|permitted) to (run|execute|use)/i,
  /tool[^.\n]{0,30}(not allowed|disallowed|denied)/i,
  /sandbox[^.\n]{0,40}(denied|violation|blocked)/i,
  /couldn'?t (run|execute)[^.\n]{0,40}(shell|command)/i,
];

/**
 * Marks a denial the agent routed around. "I couldn't run the shell command, so I
 * created the file directly" describes a *successful* task, and classifying it as
 * blocked costs a needless rephrase retry — so a sentence carrying one of these is
 * not counted as evidence.
 */
const WORKAROUND_MARKERS =
  /\b(so I|instead|as an alternative|therefore I|I (then |have )?(created|wrote|added|edited|updated|generated))\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?\n])\s+/);
}

/**
 * Best-effort detection of denial evidence in free-form CLI text. Matched per
 * sentence so surrounding context can veto a hit; deduplicated because the same
 * refusal is often phrased twice.
 */
export function findDenialPhrases(text: string): string[] {
  const found = new Set<string>();
  for (const sentence of sentences(text)) {
    if (WORKAROUND_MARKERS.test(sentence)) continue;
    for (const pattern of DENIAL_PATTERNS) {
      const match = pattern.exec(sentence);
      if (match) found.add(match[0]);
    }
  }
  return [...found];
}
