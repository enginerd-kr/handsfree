import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Jail } from './jail.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jail-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-')));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'sensitive\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('Jail', () => {
  it('allows a file inside the workspace', () => {
    const jail = new Jail([root]);
    expect(jail.check(path.join(root, 'src', 'index.ts')).ok).toBe(true);
  });

  it('allows a file that does not exist yet', () => {
    const jail = new Jail([root]);
    expect(jail.check(path.join(root, 'src', 'new', 'file.ts')).ok).toBe(true);
  });

  it.each([
    ['a relative path', 'src/index.ts'],
    ['an empty path', ''],
    ['a null byte', '/tmp/a\0b'],
  ])('refuses %s', (_name, target) => {
    const jail = new Jail([root]);
    expect(jail.check(target).ok).toBe(false);
  });

  it('refuses a traversal that normalises out of the workspace', () => {
    const jail = new Jail([root]);
    const verdict = jail.check(path.join(root, '..', path.basename(outside), 'secret.txt'));
    expect(verdict.ok).toBe(false);
  });

  it('refuses a sibling directory whose name shares the prefix', () => {
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    try {
      const jail = new Jail([root]);
      expect(jail.check(path.join(sibling, 'file.txt')).ok).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('refuses a symlink that points out of the workspace', () => {
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link);
    try {
      const jail = new Jail([root], { followSymlinks: true });
      const verdict = jail.check(path.join(link, 'secret.txt'));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain('resolves outside');
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('refuses any symlink at all when following is switched off', () => {
    const target = path.join(root, 'src', 'index.ts');
    const link = path.join(root, 'inside-link.ts');
    fs.symlinkSync(target, link);
    try {
      expect(new Jail([root], { followSymlinks: false }).check(link).ok).toBe(false);
      expect(new Jail([root], { followSymlinks: true }).check(link).ok).toBe(true);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('reports paths relative to the workspace for display', () => {
    const jail = new Jail([root]);
    expect(jail.display(path.join(root, 'src', 'index.ts'))).toBe('src/index.ts');
  });
});
