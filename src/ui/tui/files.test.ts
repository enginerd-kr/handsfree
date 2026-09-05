import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { completeFile, fileTokenAt, readDirectory, suggestFiles } from './files.js';
import { parseMention } from '../../orchestrator/conversation/mention.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('file references', () => {
  it('finds paths at a code point cursor without opening for emails or models', () => {
    const value = '🙂 @"./설계 문서/"';
    expect(fileTokenAt(value, [...value].length)).toEqual({ start: 2, query: './설계 문서/' });
    expect(fileTokenAt('@src/app', 8)).toEqual({ start: 0, query: 'src/app' });
    expect(fileTokenAt('me@src', 6)).toBeUndefined();
    expect(fileTokenAt('@claude:opus', 12)).toBeUndefined();
    expect(fileTokenAt('@src/ ', 6)).toBeUndefined();
  });

  it('browses one level and excludes internal directories and outside symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'handsfree-files-'));
    roots.push(root);
    await Promise.all(['src', '.git', 'node_modules', '.handsfree'].map((name) => fs.mkdir(path.join(root, name))));
    await fs.writeFile(path.join(root, 'README.md'), 'hello');
    await fs.writeFile(path.join(root, 'src', '앱.ts'), '');
    await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
    const entries = await readDirectory(root, './');
    expect(entries).toEqual([
      { path: './src/', directory: true },
      { path: './README.md', directory: false },
    ]);
    expect(suggestFiles('@rea', 4, entries).map((e) => e.path)).toEqual(['./README.md']);
    expect(suggestFiles('@./src/', 7, entries)).toEqual([]);
    const children = await readDirectory(root, './src/');
    expect(suggestFiles('@./src/', 7, children).map((e) => e.path)).toEqual(['./src/앱.ts']);
    expect(await readDirectory(root, './outside/')).toEqual([]);
    expect(await readDirectory(root, '../')).toEqual([]);
    expect(await readDirectory(root, './missing/')).toEqual([]);
  });

  it('completes quoted paths and preserves surrounding text without routing a file as an agent', () => {
    const directory = completeFile({ value: '🙂 @설', cursor: 4 }, { path: './설계 문서/', directory: true });
    expect(directory).toEqual({ value: '🙂 @"./설계 문서/"', cursor: 13 });
    const file = completeFile(directory, { path: './설계 문서/앱.ts', directory: false });
    expect(file.value).toBe('🙂 @"./설계 문서/앱.ts" ');
    expect(file.cursor).toBe([...file.value].length);
    expect(completeFile({ value: '@src/old review', cursor: 6 }, { path: './src/app.ts', directory: false }).value)
      .toBe('@./src/app.ts  review');
    const collision = completeFile({ value: '@cla', cursor: 4 }, { path: './claude', directory: false });
    expect(parseMention(`${collision.value}review`, ['claude'])).toBeUndefined();
  });
});
