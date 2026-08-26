import fs from 'node:fs';
import path from 'node:path';
import type { AgentName } from '../config/schema.js';

export interface TaskPaths {
  id: number;
  agent: AgentName;
  dir: string;
  briefFile: string;
  resultFile: string;
  rawFile: string;
  lastMessageFile: string;
}

function highestTaskId(tasksDir: string): number {
  let highest = 0;
  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = Number.parseInt(entry.name.split('-')[0] ?? '', 10);
    if (Number.isInteger(id) && id > highest) highest = id;
  }
  return highest;
}

/**
 * Per chat session, a run directory holds all file-based shared context:
 *   <runDir>/context.md                   — accumulating one-entry-per-task log
 *   <runDir>/tasks/<n>-<agent>/brief.md   — full task brief
 *   <runDir>/tasks/<n>-<agent>/result.md  — agent's own summary (or captured fallback)
 *   <runDir>/tasks/<n>-<agent>/raw.json   — raw CLI output, never fed to the LLM
 * Delegated CLIs run with cwd = runDir, so briefs reference relative paths.
 */
export class Session {
  readonly runDir: string;
  private taskCount = 0;

  constructor(workspaceRoot: string, runDir?: string) {
    if (runDir) {
      this.runDir = runDir;
    } else {
      const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
      this.runDir = path.join(workspaceRoot, 'runs', id);
    }
    const tasksDir = path.join(this.runDir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    // Resume into an existing run dir without overwriting the tasks already in it.
    this.taskCount = highestTaskId(tasksDir);
    const contextFile = this.contextFile;
    if (!fs.existsSync(contextFile)) {
      fs.writeFileSync(contextFile, '# Session context\n\n');
    }
  }

  get contextFile(): string {
    return path.join(this.runDir, 'context.md');
  }

  createTask(agent: AgentName): TaskPaths {
    this.taskCount += 1;
    const id = this.taskCount;
    const dir = path.join(this.runDir, 'tasks', `${id}-${agent}`);
    fs.mkdirSync(dir, { recursive: true });
    return {
      id,
      agent,
      dir,
      briefFile: path.join(dir, 'brief.md'),
      resultFile: path.join(dir, 'result.md'),
      rawFile: path.join(dir, 'raw.json'),
      lastMessageFile: path.join(dir, 'last-message.txt'),
    };
  }

  relative(file: string): string {
    return path.relative(this.runDir, file);
  }

  /** Belt and braces: context sharing must never depend on the CLI obeying. */
  ensureResult(task: TaskPaths, fallbackMessage: string): string {
    if (!fs.existsSync(task.resultFile) || fs.readFileSync(task.resultFile, 'utf8').trim() === '') {
      fs.writeFileSync(task.resultFile, fallbackMessage);
    }
    return fs.readFileSync(task.resultFile, 'utf8');
  }

  writeRaw(task: TaskPaths, raw: string): void {
    fs.writeFileSync(task.rawFile, raw);
  }

  appendContext(entry: string): void {
    fs.appendFileSync(this.contextFile, entry.trimEnd() + '\n');
  }
}
