import { builtins } from './builtins.js';
import { loadCommandFiles } from './files.js';
import type { Command } from './command.js';

export interface Registry {
  commands: readonly Command[];
  /** Files that could not be read. Reported once, where a person will see it. */
  problems: readonly string[];
}

/**
 * Every command this run knows, built once when the runtime is. Discovery is a
 * handful of synchronous reads over two directories, the same shape as loading
 * the config, and doing it once means the menu, `/help` and the conversation
 * are all reading the same list rather than three snapshots of the disk.
 */
export function loadCommands(cwd = process.cwd()): Registry {
  const commands = builtins();
  const taken = new Set<string>();
  for (const command of commands) {
    taken.add(command.name.toLowerCase());
    for (const alias of command.aliases ?? []) taken.add(alias.toLowerCase());
  }

  const loaded = loadCommandFiles(cwd, taken);
  return { commands: [...commands, ...loaded.commands], problems: loaded.problems };
}
