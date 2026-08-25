import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachLog } from '../support/reportStore.js';

const DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

export interface HeadlessResult {
  stdout: string;
  exitCode: number | undefined;
  /** The run directory the app created (parsed from the [workspace] line). */
  runDir: string;
}

export function makeWorkspace(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `handsfree-e2e-${name}-`));
}

export function cleanupWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Runs the real built app in one-shot headless mode against the real LLM
 * endpoint and real frontier CLIs. No mocks anywhere.
 */
export async function runHeadless(
  prompt: string,
  workspaceRoot: string,
  opts: { timeoutMs?: number; model?: string; configFile?: string } = {},
): Promise<HeadlessResult> {
  const result = await execa(
    'node',
    [
      DIST,
      '--headless',
      '-p',
      prompt,
      '--workspace',
      workspaceRoot,
      ...(opts.configFile ? ['--config', opts.configFile] : []),
    ],
    {
      timeout: opts.timeoutMs ?? 280_000,
      reject: false,
      all: true,
      env: {
        ...process.env,
        HANDSFREE_LLM_BASE_URL: process.env.HANDSFREE_LLM_BASE_URL ?? 'http://localhost:1234/v1',
        HANDSFREE_LLM_MODEL: opts.model ?? process.env.HANDSFREE_LLM_MODEL ?? 'google/gemma-3-12b',
      },
    },
  );
  const stdout = result.all ?? '';
  attachLog(`stdout: ${prompt.slice(0, 60)}`, stdout);
  const runDir = /\[workspace\] (.+)/.exec(stdout)?.[1]?.trim() ?? '';
  return { stdout, exitCode: result.exitCode, runDir };
}
