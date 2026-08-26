export interface BriefInput {
  task: string;
  doneWhen: string | undefined;
  workspaceDir: string;
  /** The first brief of a session explains the ground rules; later ones do not. */
  first: boolean;
}

/**
 * What the agent is actually told. It is short on purpose: the session keeps its
 * own memory, so repeating the preamble every task would only crowd out the part
 * that changed.
 */
export function buildBrief(input: BriefInput): string {
  const lines = [input.task];
  if (input.doneWhen) lines.push('', `Done when: ${input.doneWhen}`);
  if (input.first) {
    lines.push(
      '',
      `Work inside ${input.workspaceDir}. Everything you create must live there.`,
      'handsfree approves or refuses every file operation and every command you request.',
      'If something is refused, do not retry it and do not work around it — finish what you can and say plainly what was refused.',
      'End your turn with a short account of what you did.',
    );
  }
  return lines.join('\n');
}
