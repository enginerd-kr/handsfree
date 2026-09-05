import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigSchema, DEFAULT_AGENTS, RolesSchema, type Config } from './schema.js';

export interface ConfigLocation {
  file: string;
  scope: 'user';
}

/** One user-wide settings file, shared by every project and entry point. */
export function configPath(home = os.homedir()): string {
  return path.join(home, '.handsfree', 'config.json');
}

/** Optional agent-role overrides shared by all projects. */
export function agentsConfigPath(home = os.homedir()): string {
  return path.join(home, '.handsfree', 'agents.json');
}

export interface LoadedConfig {
  config: Config;
  /** Empty when the file does not exist and built-in defaults were used. */
  sources: ConfigLocation[];
}

export function loadConfig(cwd = process.cwd(), home = os.homedir()): LoadedConfig {
  const file = configPath(home);
  const sources: ConfigLocation[] = [agentsConfigPath(home), file]
    .filter((source) => fs.existsSync(source)).map((file) => ({ file, scope: 'user' }));
  const config = validateUserConfig(readConfigFile(file), home);
  config.workspaceRoot = config.workspaceRoot
    ? path.resolve(cwd, config.workspaceRoot)
    : path.join(home, '.handsfree');
  return { config, sources };
}

export function describeSources(sources: readonly ConfigLocation[]): string {
  return sources.length === 0 ? 'default config' : sources.map((source) => source.file).join(', ');
}

/**
 * Re-read before editing, preserve unrelated keys, and replace only after
 * validation. `edit` sees the file as stored — deltas, not the composed whole —
 * so what it writes back is what the user changed and nothing more.
 */
export function updateConfig(
  edit: (raw: Record<string, unknown>, config: Config) => void,
  home = os.homedir(),
): string {
  const file = configPath(home);
  const raw = readConfigFile(file);
  edit(raw, validateUserConfig(raw, home));
  validateUserConfig(raw, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.config-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return file;
}

function readConfigFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error(`${file} must hold a JSON object.`);
  // The former native-tool execution switch no longer controls any adapter.
  // Drop legacy values so a later settings save also removes them from disk.
  if (isRecord(raw.agents)) {
    for (const profile of Object.values(raw.agents)) {
      if (isRecord(profile)) delete profile.nativeTools;
    }
  }
  // Keep the old flat endpoint spelling usable inside the new settings file.
  if (raw.orchestration === undefined && isRecord(raw.llm)) {
    raw.orchestration = { provider: 'local', local: raw.llm };
    delete raw.llm;
  }
  // Tool replies always preserve the agent's answer.
  if (isRecord(raw.orchestration)) delete raw.orchestration.relayAnswers;
  return raw;
}

/**
 * The file stores what the user changed; the built-in profiles are never
 * copied into it. An entry for a built-in agent is a delta over its default:
 * the fields it names win and the rest are inherited, so
 * `{ "codex": { "model": "x" } }` is a complete setting. The launch line is
 * the one exception — `command` and `args` are a unit, so an entry naming
 * either supplies both. Half a default's command line joined to half a user's
 * is a command nobody wrote. Agents the defaults do not know are taken as
 * written and need a `command` of their own.
 */
export function composeConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const written = isRecord(raw.agents) ? raw.agents : {};
  const agents: Record<string, unknown> = {};
  for (const id of new Set([...Object.keys(DEFAULT_AGENTS), ...Object.keys(written)])) {
    const base = DEFAULT_AGENTS[id];
    const delta = written[id];
    if (delta === undefined) { agents[id] = { ...base, args: [...(base?.args ?? [])] }; continue; }
    // Not a record, or not a built-in: passed through for the schema to judge.
    if (!base || !isRecord(delta)) { agents[id] = delta; continue; }
    const { command, args, ...inherited } = base;
    const launch = 'command' in delta || 'args' in delta ? {} : { command, args: [...(args ?? [])] };
    agents[id] = { ...inherited, ...launch, ...delta };
  }
  return { ...raw, agents };
}

function validate(raw: Record<string, unknown>, file: string): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration in ${file}:\n${issues}`);
  }
  return parsed.data;
}

function validateUserConfig(raw: Record<string, unknown>, home: string): Config {
  const file = configPath(home);
  const composed = composeConfig(raw);
  const config = validate(composed, file);
  const roleFile = agentsConfigPath(home);
  let text: string;
  try { text = fs.readFileSync(roleFile, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return config;
    throw error;
  }
  let roles: unknown;
  try { roles = JSON.parse(text); }
  catch (error) { throw new Error(`${roleFile} is not valid JSON: ${(error as Error).message}`); }
  const parsed = RolesSchema.safeParse(roles);
  if (!parsed.success) throw new Error(`Invalid agent roles in ${roleFile}: ${parsed.error.message}`);
  return validate({ ...composed, roles: { ...config.roles, ...parsed.data } }, `${roleFile}, ${file}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
