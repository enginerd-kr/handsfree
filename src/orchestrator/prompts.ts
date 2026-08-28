export type TaskKind = 'answer' | 'change';

export interface BriefInput {
  task: string;
  /** Whether the agent is being asked for words or for a changed workspace. */
  kind: TaskKind;
  doneWhen: string | undefined;
  workspaceDir: string;
  /** The first brief of a session explains the ground rules; later ones do not. */
  first: boolean;
  /**
   * What the other agents did since this one last worked, rendered by
   * `renderHandoff`. Empty when nothing did — the section is then left out,
   * not left in with nothing under it.
   */
  handoff?: string;
}

/**
 * What the agent is actually told. It is short on purpose: the session keeps its
 * own memory, so repeating the preamble every task would only crowd out the part
 * that changed.
 *
 * An answer task says so in the brief rather than leaving it to be inferred. An
 * agent handed a bare question inside a workspace will otherwise write the
 * answer to a file, because that is what a coding agent is for.
 */
export function buildBrief(input: BriefInput): string {
  const lines = [input.task];
  if (input.kind === 'answer') {
    lines.push(
      '',
      'This is a question, not a change. Put your answer in your reply.',
      'Do not create, modify or delete any file, and do not run any command.',
    );
  }
  if (input.doneWhen) lines.push('', `Done when: ${input.doneWhen}`);
  if (input.handoff) lines.push('', input.handoff);
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
