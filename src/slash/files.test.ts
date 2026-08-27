import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandSearchPaths, loadCommandFiles, parseFrontmatter } from './files.js';
import type { Command } from './command.js';

let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A project directory with the given files under `.handsfree/commands`. */
function project(files: Record<string, string>): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-commands-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, '.handsfree', 'commands', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

/**
 * Only what came from this test's own directory. The user's real command
 * directory is one of the search paths, and a suite that read it would pass or
 * fail depending on whose machine it ran on.
 */
function mine(cwd: string): Command[] {
  return loadCommandFiles(cwd).commands.filter(
    (command) => command.kind === 'prompt' && command.file.startsWith(cwd),
  );
}

describe('parseFrontmatter', () => {
  it('reads the block and hands back the rest', () => {
    const parsed = parseFrontmatter('---\ndescription: review a path\n---\nReview $ARGUMENTS.\n');
    expect(parsed.fields).toEqual({ description: 'review a path' });
    expect(parsed.body).toBe('Review $ARGUMENTS.');
  });

  it('strips one layer of quotes', () => {
    expect(parseFrontmatter('---\nargument-hint: "[path]"\n---\nx').fields['argument-hint']).toBe(
      '[path]',
    );
  });

  // A document that opens with a rule is a document, not a frontmatter block.
  it('treats an unclosed block as body', () => {
    const parsed = parseFrontmatter('---\ndescription: x\nstill going');
    expect(parsed.fields).toEqual({});
    expect(parsed.body).toBe('---\ndescription: x\nstill going');
  });

  it('is body all the way down when there is no block', () => {
    expect(parseFrontmatter('Review the diff.').body).toBe('Review the diff.');
  });

  it('ignores a line that is not a key', () => {
    expect(parseFrontmatter('---\ndescription: x\njust prose\n---\ny').fields).toEqual({
      description: 'x',
    });
  });
});

describe('commandSearchPaths', () => {
  it('looks in the project before the user, the way the config does', () => {
    const paths = commandSearchPaths('/work');
    expect(paths[0]).toEqual({ dir: path.join('/work', '.handsfree', 'commands'), source: 'project' });
    expect(paths[1]?.source).toBe('user');
  });
});

describe('loadCommandFiles', () => {
  it('reads a file into a prompt command', () => {
    const cwd = project({
      'review.md': '---\ndescription: review a path\nargument-hint: "[path]"\narguments: path\n---\nReview $path.\n',
    });
    const [command] = mine(cwd);
    expect(command).toMatchObject({
      kind: 'prompt',
      name: 'review',
      description: 'review a path',
      argumentHint: '[path]',
      argNames: ['path'],
      body: 'Review $path.',
      source: 'project',
    });
  });

  it('makes a namespace out of a sub-directory', () => {
    const cwd = project({ 'frontend/deploy.md': 'Deploy it.' });
    expect(mine(cwd)[0]?.name).toBe('frontend:deploy');
  });

  it('takes the first real line as a description when none was given', () => {
    const cwd = project({ 'x.md': '\n# Review the diff\n\nand say what you find.\n' });
    expect(mine(cwd)[0]?.description).toBe('Review the diff');
  });

  it('reads only markdown, and nothing hidden', () => {
    const cwd = project({ 'a.md': 'x', 'notes.txt': 'x', '.drafts/b.md': 'x' });
    expect(mine(cwd).map((command) => command.name)).toEqual(['a']);
  });

  it('leaves a name that is already claimed alone', () => {
    const cwd = project({ 'quit.md': 'not this one' });
    const loaded = loadCommandFiles(cwd, new Set(['quit']));
    expect(loaded.commands.some((command) => command.name === 'quit')).toBe(false);
  });

  it('says nothing about a directory that is not there', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-commands-'));
    expect(loadCommandFiles(root).problems).toEqual([]);
  });

  it('reports a file it cannot use instead of failing to start', () => {
    const cwd = project({ 'big.md': 'x' });
    fs.writeFileSync(path.join(cwd, '.handsfree', 'commands', 'big.md'), 'x'.repeat(70 * 1024));
    const loaded = loadCommandFiles(cwd);
    expect(loaded.commands.some((command) => command.name === 'big')).toBe(false);
    expect(loaded.problems.join('\n')).toContain('big.md');
  });

  // A command directory is not a licence to enumerate whatever it points at.
  it('does not walk a symlinked directory', () => {
    const cwd = project({ 'a.md': 'x' });
    const elsewhere = path.join(cwd, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'b.md'), 'x');
    fs.symlinkSync(elsewhere, path.join(cwd, '.handsfree', 'commands', 'linked'));
    expect(mine(cwd).map((command) => command.name)).toEqual(['a']);
  });
});
