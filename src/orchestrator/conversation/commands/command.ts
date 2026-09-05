import type { Config } from '../../../config/schema.js';
import type { ConfigLocation } from '../../../config/load.js';
import type { Jail } from '../../../policy/jail.js';
import type { PolicyEngine } from '../../../policy/engine.js';
import type { Transcript } from '../../../workspace/transcript.js';
import type { Workspace } from '../../../workspace/workspace.js';

/** Where a command came from. Shown beside it in the menu and in `/help`. */
export type CommandSource = 'builtin' | 'project' | 'user';

/** What a command is, as far as the menu and `/help` are concerned. */
export interface CommandBase {
  /** What follows the slash. A sub-directory becomes a namespace: `frontend:deploy`. */
  name: string;
  /** One line. Long enough to say what it does, short enough for a menu row. */
  description: string;
  aliases?: readonly string[];
  /** Dimmed after the name in the menu, e.g. `[path]`. Display only. */
  argumentHint?: string;
  source: CommandSource;
}

/**
 * What a local command did. It describes the effect rather than performing it,
 * because the same command means different things in different seats: `quit`
 * unmounts the terminal UI, and `handsfree run` has nothing to unmount. Keeping
 * the command a pure function is also what makes it testable without a runtime.
 */
export type CommandEffect =
  | { do: 'say'; text: string; lines?: string[] }
  /** Forget the conversation, and take the screen with it. */
  | { do: 'clear' }
  | { do: 'models' }
  | { do: 'work-mode'; mode: 'plan' | 'execute'; prompt: string }
  | { do: 'quit' };

/**
 * A command handsfree answers itself. No agent is woken and no orchestration
 * turn is spent — which is why `/help` still works on a machine with no agents
 * configured at all.
 */
export interface LocalCommand {
  kind: 'local';
  /**
   * Only the terminal UI can carry this out, so everywhere else says so rather
   * than pretending. Leaving is the example: there is nothing to leave in a
   * single `run` turn.
   */
  interactive?: boolean;
  run(args: string, host: CommandHost): CommandEffect;
}

/** A markdown file whose body, once expanded, becomes the message the model gets. */
export interface PromptCommand {
  kind: 'prompt';
  /** Names for the positional arguments, from the `arguments:` frontmatter. */
  argNames: readonly string[];
  body: string;
  /** The file it was read from — the only thing that can name it in an error. */
  file: string;
}

export type Command = CommandBase & (LocalCommand | PromptCommand);

/**
 * Everything a command needs. It is the connection-scoped `HostContext` widened
 * by the two things only a command asks for, rather than a bag of its own: an
 * expansion goes through the very same policy engine an agent's command does,
 * so it may as well arrive holding the same shape.
 */
export interface CommandHost {
  /** Who is asking, as the audit trail and the approval box will name them. */
  agentId: string;
  config: Config;
  /** The user settings source. Empty when built-in defaults were used. */
  configSources: readonly ConfigLocation[];
  workspace: Workspace;
  jail: Jail;
  policy: PolicyEngine;
  transcript: Transcript;
  commands: readonly Command[];
}

/**
 * A typed line split into the command and everything after it. The arguments
 * stay one raw string: that is what `$ARGUMENTS` interpolates, and splitting is
 * a decision the substitution makes, not the parser.
 *
 * A slash only opens a command at the start of the line. Mid-sentence it is a
 * slash — a path, a fraction, an and/or — and nothing here should touch it.
 */
export function parseSlashCommand(input: string): { name: string; args: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const rest = trimmed.slice(1);
  const gap = rest.search(/\s/);
  const name = gap === -1 ? rest : rest.slice(0, gap);
  if (name === '') return undefined;
  return { name, args: gap === -1 ? '' : rest.slice(gap + 1).trim() };
}

/**
 * Whether a name could be a command at all. Anything else — a second slash, a
 * dot, a tilde — means the line was a path rather than an invocation, and a
 * path is sent to the model as the ordinary text it is instead of being
 * refused as a command nobody wrote.
 */
export function looksLikeCommand(name: string): boolean {
  return !/[^a-zA-Z0-9:_-]/.test(name);
}

export function findCommand(
  name: string,
  commands: readonly Command[],
): Command | undefined {
  const wanted = name.toLowerCase();
  return commands.find(
    (command) =>
      command.name.toLowerCase() === wanted ||
      command.aliases?.some((alias) => alias.toLowerCase() === wanted),
  );
}

/** Whether pressing enter on a suggestion should send it or only fill it in. */
export function takesArguments(command: Command): boolean {
  if (command.argumentHint !== undefined) return true;
  return command.kind === 'prompt' && command.argNames.length > 0;
}

/**
 * The commands worth offering for a half-written line, best first.
 *
 * Prefix before fuzz, deliberately: a menu that reorders itself on every
 * keystroke is a menu you cannot aim at, and `fuse.js` for a list this size
 * would be a dependency bought with the thing it was meant to improve.
 *
 * Nothing is offered once a space has been typed. By then the command has been
 * chosen and what is being written is its arguments.
 */
export function suggest(value: string, commands: readonly Command[]): Command[] {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('/')) return [];
  const query = trimmed.slice(1);
  if (/\s/.test(query)) return [];

  const wanted = query.toLowerCase();
  const scored: { command: Command; score: number }[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const aliases = (command.aliases ?? []).map((alias) => alias.toLowerCase());
    let score: number;
    if (wanted === '') score = 1;
    else if (name === wanted || aliases.includes(wanted)) score = 0;
    else if (name.startsWith(wanted)) score = 1;
    else if (aliases.some((alias) => alias.startsWith(wanted))) score = 2;
    else if (name.includes(wanted)) score = 3;
    else if (command.description.toLowerCase().includes(wanted)) score = 4;
    else continue;
    scored.push({ command, score });
  }

  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.command.name.length - b.command.name.length ||
        a.command.name.localeCompare(b.command.name),
    )
    .map((entry) => entry.command);
}
