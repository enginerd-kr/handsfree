import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneOldRuns, runStartTime } from './prune.js';

let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function workspaceRoot(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-prune-'));
  return root;
}

/** A run id the way `newRunId` would have minted it on the given day. */
function idAgedDays(days: number, pid = 12345): string {
  const stamp = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  return `${stamp}-${pid}`;
}

function makeRun(base: string, ...segments: string[]): string {
  const dir = path.join(base, ...segments);
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '');
  return dir;
}

describe('runStartTime', () => {
  it('reads the stamp back as the UTC instant it encoded', () => {
    expect(runStartTime('2026-08-26T13-11-39-12154')).toBe(Date.parse('2026-08-26T13:11:39Z'));
  });

  it('refuses names it did not mint', () => {
    expect(runStartTime('notes')).toBeUndefined();
    expect(runStartTime('2026-08-26')).toBeUndefined();
  });
});

describe('pruneOldRuns', () => {
  it('removes runs past the cutoff and keeps the rest', () => {
    const base = workspaceRoot();
    const old = makeRun(base, 'runs', idAgedDays(31));
    const fresh = makeRun(base, 'runs', idAgedDays(1));

    expect(pruneOldRuns(base, 30)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('does nothing when the period is 0', () => {
    const base = workspaceRoot();
    const old = makeRun(base, 'runs', idAgedDays(400));

    expect(pruneOldRuns(base, 0)).toBe(0);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('leaves directories whose names it cannot date', () => {
    const base = workspaceRoot();
    const stranger = makeRun(base, 'runs', 'kept-by-hand');

    expect(pruneOldRuns(base, 30)).toBe(0);
    expect(fs.existsSync(stranger)).toBe(true);
  });

  it('spares the run it was told is alive, however old', () => {
    const base = workspaceRoot();
    const id = idAgedDays(90);
    const current = makeRun(base, 'runs', id);

    expect(pruneOldRuns(base, 30, id)).toBe(0);
    expect(fs.existsSync(current)).toBe(true);
  });

  it('sweeps attached runs and removes a project directory it emptied', () => {
    const base = workspaceRoot();
    const emptied = path.join(base, 'attached', 'proj-aaaaaaaa');
    makeRun(emptied, idAgedDays(31));
    const surviving = path.join(base, 'attached', 'proj-bbbbbbbb');
    makeRun(surviving, idAgedDays(31));
    const kept = makeRun(surviving, idAgedDays(1));

    expect(pruneOldRuns(base, 30)).toBe(2);
    expect(fs.existsSync(emptied)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(surviving)).toBe(true);
  });

  it('is quiet when the root has never been used', () => {
    expect(pruneOldRuns(workspaceRoot(), 30)).toBe(0);
  });
});
