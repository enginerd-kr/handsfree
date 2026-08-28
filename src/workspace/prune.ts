import fs from 'node:fs';
import path from 'node:path';
import { debug } from '../debug.js';

/**
 * Nothing ever deleted a run until this did. Every launch mints a directory
 * under `<root>/runs` (or `<root>/attached/<project>`), so a machine that uses
 * handsfree daily accumulates hundreds of them — small, but unbounded.
 *
 * The policy is a single age cutoff, judged from the run id itself: the id
 * begins with the UTC stamp `newRunId` wrote, so age needs no stat call, and a
 * directory whose name this module cannot date is one it never made — those
 * are left alone rather than guessed at. A cutoff measured in days is also the
 * liveness check: a run still in use was created moments ago, not weeks.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes runs older than `cleanupPeriodDays`, sparing `keepId` (the run the
 * caller is living in). 0 days turns pruning off. Returns how many went.
 */
export function pruneOldRuns(root: string, cleanupPeriodDays: number, keepId?: string): number {
  if (cleanupPeriodDays <= 0) return 0;
  const cutoff = Date.now() - cleanupPeriodDays * DAY_MS;

  let removed = pruneRunsIn(path.join(root, 'runs'), cutoff, keepId);
  for (const projectDir of subdirs(path.join(root, 'attached'))) {
    removed += pruneRunsIn(projectDir, cutoff, keepId);
    // A project directory whose last run just left is an empty shell; rmdir
    // refuses non-empty directories, so surviving runs protect their own.
    try {
      fs.rmdirSync(projectDir);
    } catch {
      // Not empty, or already gone — both fine.
    }
  }
  if (removed > 0) {
    debug('prune', `removed ${removed} run(s) older than ${cleanupPeriodDays} day(s) from ${root}`);
  }
  return removed;
}

function pruneRunsIn(dir: string, cutoff: number, keepId?: string): number {
  let removed = 0;
  for (const runDir of subdirs(dir)) {
    const id = path.basename(runDir);
    if (id === keepId) continue;
    const started = runStartTime(id);
    if (started === undefined || started >= cutoff) continue;
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      debug('prune', `could not remove ${runDir}: ${(err as Error).message}`);
    }
  }
  return removed;
}

/** When the run began, read back out of the id `newRunId` built — or undefined. */
export function runStartTime(id: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-\d+$/.exec(id);
  if (!match) return undefined;
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  return Number.isNaN(time) ? undefined : time;
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}
