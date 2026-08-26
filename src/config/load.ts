import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

export const CONFIG_FILENAME = 'handsfree.config.json';

export function configSearchPaths(cwd = process.cwd()): string[] {
  return [
    path.join(cwd, CONFIG_FILENAME),
    path.join(os.homedir(), '.config', 'handsfree', 'config.json'),
  ];
}

export interface LoadedConfig {
  config: Config;
  /** File the settings came from, or undefined when defaults were used. */
  source: string | undefined;
}

export function loadConfig(cwd = process.cwd()): LoadedConfig {
  let raw: unknown = {};
  let source: string | undefined;
  for (const candidate of configSearchPaths(cwd)) {
    if (!fs.existsSync(candidate)) continue;
    try {
      raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (err) {
      throw new Error(`${candidate} is not valid JSON: ${(err as Error).message}`);
    }
    source = candidate;
    break;
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const where = source ?? 'default config';
    throw new Error(`Invalid configuration in ${where}:\n${formatIssues(parsed.error)}`);
  }

  const config = parsed.data;
  config.workspaceRoot = config.workspaceRoot
    ? path.resolve(cwd, config.workspaceRoot)
    : path.join(os.homedir(), '.handsfree');
  return { config, source };
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}
