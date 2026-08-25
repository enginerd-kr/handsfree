import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

function readJsonIfExists(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Failed to read config file ${file}: ${(err as Error).message}`);
  }
}

function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    ) {
      out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export interface ConfigOverrides {
  baseURL?: string;
  model?: string;
  apiKey?: string;
  workspaceRoot?: string;
  configFile?: string;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const globalFile = path.join(os.homedir(), '.config', 'handsfree', 'config.json');
  const localFile = overrides.configFile ?? path.join(process.cwd(), 'handsfree.config.json');

  let merged = deepMerge(readJsonIfExists(globalFile), readJsonIfExists(localFile));

  const env: Record<string, unknown> = { llm: {} };
  const llmEnv = env.llm as Record<string, unknown>;
  if (process.env.HANDSFREE_LLM_BASE_URL) llmEnv.baseURL = process.env.HANDSFREE_LLM_BASE_URL;
  if (process.env.HANDSFREE_LLM_MODEL) llmEnv.model = process.env.HANDSFREE_LLM_MODEL;
  if (process.env.HANDSFREE_LLM_API_KEY) llmEnv.apiKey = process.env.HANDSFREE_LLM_API_KEY;
  if (process.env.HANDSFREE_WORKSPACE_ROOT) env.workspaceRoot = process.env.HANDSFREE_WORKSPACE_ROOT;
  merged = deepMerge(merged, env);

  const flagOverrides: Record<string, unknown> = { llm: {} };
  const llmFlags = flagOverrides.llm as Record<string, unknown>;
  if (overrides.baseURL) llmFlags.baseURL = overrides.baseURL;
  if (overrides.model) llmFlags.model = overrides.model;
  if (overrides.apiKey) llmFlags.apiKey = overrides.apiKey;
  if (overrides.workspaceRoot) flagOverrides.workspaceRoot = overrides.workspaceRoot;
  merged = deepMerge(merged, flagOverrides);

  const config = ConfigSchema.parse(merged);
  if (!config.workspaceRoot) {
    config.workspaceRoot = path.join(os.homedir(), '.handsfree', 'workspaces');
  }
  return config;
}
