import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Jail } from '../policy/jail.js';
import type { Policy } from '../config/schema.js';

/**
 * A run owns two directories that must not be the same one:
 *
 *   <root>/runs/<id>/transcript.jsonl   the record — outside the jail
 *   <root>/runs/<id>/sessions.json      agent session ids, for resuming
 *   <root>/runs/<id>/workspace/         the jail root, and every agent's cwd
 *
 * Keeping the transcript above the workspace is deliberate: an audit log an
 * agent can edit is not an audit log.
 */
export class Workspace {
  readonly runDir: string;
  readonly dir: string;
  readonly transcriptFile: string;
  readonly sessionsFile: string;

  private constructor(runDir: string, dir?: string) {
    this.runDir = runDir;
    this.dir = dir ?? path.join(runDir, 'workspace');
    this.transcriptFile = path.join(runDir, 'transcript.jsonl');
    this.sessionsFile = path.join(runDir, 'sessions.json');
  }

  static open(root: string, runId?: string): Workspace {
    const id = runId ?? newRunId();
    const provisional = path.join(root, 'runs', id);
    fs.mkdirSync(path.join(provisional, 'workspace'), { recursive: true });
    // Agents are given this path as their cwd and hand it back in every request,
    // so it has to be the resolved one — otherwise every path they send arrives
    // as an alias of the workspace rather than the workspace.
    return new Workspace(fs.realpathSync(provisional));
  }

  /**
   * A workspace that already exists — an editor's project directory. The record
   * is kept under the handsfree root rather than inside the project, because a
   * transcript stored in the jail is a transcript the agent can rewrite.
   */
  static attach(projectDir: string, recordRoot: string): Workspace {
    const dir = fs.realpathSync(projectDir);
    const runDir = path.join(recordRoot, 'attached', slug(dir), newRunId());
    fs.mkdirSync(runDir, { recursive: true });
    return new Workspace(runDir, dir);
  }

  static latest(root: string): Workspace | undefined {
    const runsDir = path.join(root, 'runs');
    if (!fs.existsSync(runsDir)) return undefined;
    const ids = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const id = ids.at(-1);
    return id === undefined ? undefined : Workspace.open(root, id);
  }

  get id(): string {
    return path.basename(this.runDir);
  }

  jail(policy: Policy): Jail {
    return new Jail([this.dir], { followSymlinks: policy.fs.followSymlinks });
  }

  /** Session ids per agent, so a restart can resume instead of starting over. */
  readSessionIds(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return {};
      const out: Record<string, string> = {};
      for (const [agent, id] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof id === 'string') out[agent] = id;
      }
      return out;
    } catch {
      return {};
    }
  }

  writeSessionId(agentId: string, sessionId: string): void {
    const all = { ...this.readSessionIds(), [agentId]: sessionId };
    fs.writeFileSync(this.sessionsFile, `${JSON.stringify(all, null, 2)}\n`);
  }
}

/** A readable, collision-resistant directory name for an attached project. */
function slug(dir: string): string {
  const name = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
  return `${name}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stamp}-${process.pid}`;
}
