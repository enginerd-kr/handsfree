import fs from 'node:fs/promises';
import path from 'node:path';
import { useEffect, useState } from 'react';

export interface FileEntry {
  path: string;
  directory: boolean;
}

/** File references count code points, just like the prompt cursor. */
export function fileTokenAt(value: string, cursor: number): { start: number; query: string } | undefined {
  const before = [...value].slice(0, cursor).join('');
  const match = /(?:^|\s)@(?:"([^"\n]*)"?|([^\s":]*))$/u.exec(before);
  if (!match) return undefined;
  const token = match[0].trimStart();
  return { start: [...before].length - [...token].length, query: match[1] ?? match[2]! };
}

function directoryFor(query: string): string {
  return query.slice(0, query.lastIndexOf('/') + 1) || './';
}

/** Read one level on demand; large workspaces never need a recursive scan. */
export async function readDirectory(root: string, directory: string): Promise<FileEntry[]> {
  try {
    const base = await fs.realpath(root);
    const target = await fs.realpath(path.resolve(base, directory));
    const relative = path.relative(base, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => (entry.isFile() || entry.isDirectory()) &&
        !['.git', 'node_modules', '.handsfree'].includes(entry.name) && !/["\r\n]/u.test(entry.name))
      .map((entry) => ({
        path: `./${path.posix.join(directory, entry.name)}${entry.isDirectory() ? '/' : ''}`,
        directory: entry.isDirectory(),
      }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

export function useFileEntries(root: string, value: string, cursor: number): FileEntry[] {
  const token = fileTokenAt(value, cursor);
  const directory = token ? directoryFor(token.query) : undefined;
  const [listing, setListing] = useState<{ root: string; directory: string; entries: FileEntry[] }>();
  useEffect(() => {
    if (directory === undefined) return;
    let active = true;
    void readDirectory(root, directory).then((entries) => {
      if (active) setListing({ root, directory, entries });
    });
    return () => { active = false; };
  }, [root, directory]);
  return listing?.root === root && listing.directory === directory ? listing.entries : [];
}

export function suggestFiles(value: string, cursor: number, entries: readonly FileEntry[]): FileEntry[] {
  const token = fileTokenAt(value, cursor);
  if (!token) return [];
  const directory = directoryFor(token.query);
  const wanted = token.query.slice(token.query.lastIndexOf('/') + 1).toLowerCase();
  const parent = path.posix.normalize(directory);
  return entries.filter((entry) =>
    path.posix.normalize(`${path.posix.dirname(entry.path.replace(/\/$/, ''))}/`) === parent &&
    path.posix.basename(entry.path).toLowerCase().includes(wanted));
}

export function completeFile(
  draft: { value: string; cursor: number },
  entry: FileEntry,
): { value: string; cursor: number } {
  const token = fileTokenAt(draft.value, draft.cursor);
  if (!token) return draft;
  const chars = [...draft.value];
  // Replace the rest of this token too when completing from its middle.
  let end = draft.cursor;
  const quoted = chars[token.start + 1] === '"';
  const alreadyClosed = quoted && chars[end - 1] === '"';
  if (!alreadyClosed) {
    while (end < chars.length && (quoted ? chars[end] !== '"' : !/\s/.test(chars[end]!))) end++;
    if (quoted && chars[end] === '"') end++;
  }
  const reference = /\s/.test(entry.path) ? `@"${entry.path}"` : `@${entry.path}`;
  const filled = [...reference, ...(entry.directory ? [] : [' '])];
  return {
    value: [...chars.slice(0, token.start), ...filled, ...chars.slice(end)].join(''),
    cursor: token.start + filled.length,
  };
}
