import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema, type Config } from './schema.js';

export const CONFIG_FILENAME = 'handsfree.config.json';

export type ConfigScope = 'project' | 'user';

export interface ConfigLocation {
  file: string;
  scope: ConfigScope;
}

/**
 * Where settings are read from, in the order they win — the project directory
 * first, the user's config home second. Both are read: a project file is a
 * layer *over* the user's, not a replacement for it, so a checkout can pin the
 * one thing it cares about (the agent it wants, an allowlist entry) without
 * having to restate the endpoint, the proxy and the timeouts you set once for
 * every project on the machine.
 *
 * `home` is a parameter rather than a call to `os.homedir()` so a test can lay
 * out both halves of the pair without borrowing the machine's own settings.
 */
export function configSearchPaths(cwd = process.cwd(), home = os.homedir()): ConfigLocation[] {
  return [
    { file: path.join(cwd, CONFIG_FILENAME), scope: 'project' },
    { file: path.join(home, '.config', 'handsfree', 'config.json'), scope: 'user' },
  ];
}

export interface LoadedConfig {
  config: Config;
  /** The files that contributed, strongest first. Empty when defaults were used. */
  sources: ConfigLocation[];
}

export function loadConfig(cwd = process.cwd(), home = os.homedir()): LoadedConfig {
  const sources: ConfigLocation[] = [];
  let raw: Record<string, unknown> = {};

  // Folded weakest-first, so each layer is merged onto what the ones below it
  // had already said, and the project file — read first, applied last — wins.
  for (const location of [...configSearchPaths(cwd, home)].reverse()) {
    if (!fs.existsSync(location.file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(location.file, 'utf8'));
    } catch (err) {
      throw new Error(`${location.file} is not valid JSON: ${(err as Error).message}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`${location.file} must hold a JSON object.`);
    }
    raw = mergeLayer(raw, asRecord(migrateLegacyLlm(parsed)));
    sources.unshift(location);
  }

  // Validated once, on the merged whole: a layer is a fragment, and a fragment
  // is allowed to be incomplete in ways the finished settings are not.
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid configuration in ${describeSources(sources)}:\n${formatIssues(parsed.error)}`);
  }

  const config = parsed.data;
  config.workspaceRoot = config.workspaceRoot
    ? path.resolve(cwd, config.workspaceRoot)
    : path.join(home, '.handsfree');
  return { config, sources };
}

/** The files a merged config came from, strongest first, as an error can name them. */
export function describeSources(sources: readonly ConfigLocation[]): string {
  if (sources.length === 0) return 'default config';
  return sources.map((source) => source.file).join(' over ');
}

/**
 * One settings layer laid over another. Objects merge key by key, so a project
 * file naming `policy.exec.mode` leaves the rest of `policy` as the user wrote
 * it; everything else — a scalar, an array — is replaced outright by the
 * stronger layer. Arrays are deliberately not concatenated: `policy.exec.allow`
 * is a list of what may run, and a layer that could only ever *add* to it is a
 * layer that cannot say "not here, not this".
 */
function mergeLayer(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  at: string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const here = [...at, key];
    const existing = merged[key];
    merged[key] =
      isRecord(existing) && isRecord(value) && !isWholeValue(here)
        ? mergeLayer(existing, value, here)
        : value;
  }
  return merged;
}

/**
 * A path whose object is taken whole rather than merged into. An agent profile
 * is a launch line — command, arguments and environment agreeing with one
 * another — and half of one file's profile spliced onto half of another's is a
 * command line nobody wrote and nobody checked.
 */
function isWholeValue(at: string[]): boolean {
  return at.length === 2 && at[0] === 'agents';
}

/**
 * `llm` became `orchestration` when the planner learned to run over ACP as well
 * as against a local endpoint. Old files keep working: the flat block maps onto
 * the local provider it always described. Without this, an old key would be
 * silently dropped and the defaults used in its place.
 *
 * Applied per layer, before merging, so an old user file and a new project file
 * meet each other already speaking the same shape.
 */
function migrateLegacyLlm(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const legacy = record['llm'];
  if (record['orchestration'] !== undefined) return raw;
  if (typeof legacy !== 'object' || legacy === null || Array.isArray(legacy)) return raw;

  const { maxHistoryMessages, ...local } = legacy as Record<string, unknown>;
  const { llm: _llm, ...rest } = record;
  return {
    ...rest,
    orchestration: {
      provider: 'local',
      local,
      ...(maxHistoryMessages !== undefined ? { maxHistoryMessages } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}
