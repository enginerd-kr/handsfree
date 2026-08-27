import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command, CommandSource } from './command.js';

/**
 * Where command files are looked for, in the order they win. Shaped after
 * `configSearchPaths` deliberately — the project directory first, the user's
 * config home second — with one difference: config is first-file-wins, and
 * commands are first-*name*-wins, so both directories are always read.
 *
 * The project directory is the shell's working directory, not the workspace.
 * The workspace is the agents' jail and they can write to it; a command file
 * an agent could author is a command file that runs on your machine.
 */
export function commandSearchPaths(cwd = process.cwd()): { dir: string; source: CommandSource }[] {
  return [
    { dir: path.join(cwd, '.handsfree', 'commands'), source: 'project' },
    { dir: path.join(os.homedir(), '.config', 'handsfree', 'commands'), source: 'user' },
  ];
}

/** A markdown file bigger than this is a document that wandered in, not a command. */
const MAX_FILE_BYTES = 64 * 1024;
/** A ceiling on how much of someone's disk a stray directory can enumerate. */
const MAX_COMMANDS = 200;

export interface LoadedCommands {
  commands: Command[];
  /** Files that could not be read, said plainly enough to act on. */
  problems: string[];
}

/**
 * Reads every `*.md` under the command directories. A name already taken is
 * skipped rather than replaced, so the search order above decides.
 *
 * Nothing here throws. A command directory is someone's notes; one bad file in
 * it must not stop handsfree from starting, and the problem is reported instead.
 */
export function loadCommandFiles(cwd = process.cwd(), taken: Set<string> = new Set()): LoadedCommands {
  const commands: Command[] = [];
  const problems: string[] = [];

  for (const { dir, source } of commandSearchPaths(cwd)) {
    const files: string[] = [];
    walk(dir, files, 0);
    if (files.length >= MAX_COMMANDS) {
      problems.push(`${dir}: stopped after ${MAX_COMMANDS} files.`);
    }

    for (const file of files) {
      const name = path.relative(dir, file).slice(0, -'.md'.length).split(path.sep).join(':');
      if (taken.has(name.toLowerCase())) continue;

      let text: string;
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) {
          problems.push(`${file}: larger than ${MAX_FILE_BYTES} bytes, skipped.`);
          continue;
        }
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        problems.push(`${file}: ${(err as Error).message}`);
        continue;
      }

      const { fields, body } = parseFrontmatter(text);
      taken.add(name.toLowerCase());
      commands.push({
        kind: 'prompt',
        name,
        description: fields['description'] ?? summarise(body),
        ...(fields['argument-hint'] !== undefined
          ? { argumentHint: fields['argument-hint'] }
          : {}),
        argNames: splitNames(fields['arguments']),
        body,
        file,
        source,
      });
    }
  }

  return { commands, problems };
}

/**
 * Every `*.md` under a command directory.
 *
 * The walk is written out rather than left to `readdirSync`'s recursive mode,
 * because that mode follows a symlinked directory — and a command directory is
 * not a licence to enumerate whatever something inside it points at. A link to
 * a file is still read: that is a file someone chose to put there.
 */
function walk(dir: string, out: string[], depth: number): void {
  if (depth > 8 || out.length >= MAX_COMMANDS) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Not there, or not readable. Neither is worth a word: most people have no
    // command directory at all.
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_COMMANDS) return;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, depth + 1);
      continue;
    }
    if (entry.isSymbolicLink() ? !isFile(full) : !entry.isFile()) continue;
    if (entry.name.endsWith('.md')) out.push(full);
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * The `---` block at the top of a command file, read as flat `key: value` and
 * nothing more.
 *
 * Hand-rolled on purpose. The format that matters here is three keys deep at
 * one level, and buying a YAML parser — and its dependency tree — for that
 * would mostly buy the ability to express nested settings this deliberately
 * refuses to honour.
 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fields: {}, body: text.trim() };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  // An opening rule with no closing one is a document that starts with a rule.
  if (end === -1) return { fields: {}, body: text.trim() };

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    fields[match[1]!.toLowerCase()] = unquote(match[2]!.trim());
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() };
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(value);
  return quoted ? (quoted[1] ?? quoted[2] ?? '') : value;
}

/** `arguments: branch target` and `arguments: [branch, target]` both work. */
function splitNames(value: string | undefined): string[] {
  if (!value) return [];
  const inner = /^\[(.*)\]$/.exec(value.trim());
  return (inner ? (inner[1] ?? '').split(',') : value.split(/\s+/))
    .map((name) => name.trim())
    .filter((name) => name !== '' && !/^\d+$/.test(name));
}

/** A description for a file that did not give one: its first real line. */
function summarise(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((text) => text.replace(/^#+\s*/, '').trim())
    .find((text) => text !== '');
  if (!line) return 'a command with no description';
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}
