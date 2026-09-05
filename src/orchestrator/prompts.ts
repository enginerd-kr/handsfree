import { REPORT_FORMAT, REPORT_REMINDER } from './report.js';

export type TaskKind = 'answer' | 'change';

export interface BriefInput {
  task: string;
  /** Whether the agent is being asked for words or for a changed workspace. */
  kind: TaskKind;
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
 * that changed. The task is the planner's brief as it wrote it — what to do,
 * what done looks like, and whatever from the conversation the agent needs —
 * so nothing here restates any of that.
 *
 * An answer task says so in the brief rather than leaving it to be inferred. An
 * agent handed a bare question inside a workspace will otherwise write the
 * answer to a file, because that is what a coding agent is for.
 *
 * The report format goes out with the ground rules — once per session, and
 * again whenever the rules are repeated, since a session that has compacted
 * its opening away has lost the format along with them. Every other brief ends
 * on a one-line reminder: ten tokens, against the block it earns back.
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
  if (input.handoff) lines.push('', input.handoff);
  if (input.first) {
    lines.push(
      '',
      `Work inside ${input.workspaceDir}. Everything you create must live there.`,
      'handsfree approves or refuses every file operation and every command you request.',
      'If something is refused, do not retry it and do not work around it — finish what you can and say plainly what was refused.',
      '',
      REPORT_FORMAT,
    );
  } else {
    lines.push('', REPORT_REMINDER);
  }
  return lines.join('\n');
}
