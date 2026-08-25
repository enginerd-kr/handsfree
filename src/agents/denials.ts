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

/** Best-effort detection of "blocked by permissions" evidence in CLI output. */
export function findDenialPhrases(text: string): string[] {
  const found: string[] = [];
  for (const pattern of DENIAL_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push(match[0]);
  }
  return found;
}
