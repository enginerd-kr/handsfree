import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPath, loadConfig, updateConfig } from './load.js';
import { modelDefaults, saveModelDefaults } from './models.js';
import { ConfigSchema } from './schema.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function layout(raw?: unknown) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-config-'));
  made.push(home);
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  const file = configPath(home);
  if (raw !== undefined) {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(raw));
  }
  return { cwd, home, file };
}

describe('user settings', () => {
  it('uses ~/.handsfree/config.json from every project and ignores both old paths', () => {
    const { cwd, home, file } = layout({ orchestration: { local: { model: 'global' } } });
    fs.writeFileSync(path.join(cwd, 'handsfree.config.json'), '{ invalid legacy project config');
    fs.mkdirSync(path.join(home, '.config', 'handsfree'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'handsfree', 'config.json'), '{ invalid legacy user config');
    for (const project of [cwd, path.join(home, 'another-project')]) {
      const loaded = loadConfig(project, home);
      expect(loaded.config.orchestration.local.model).toBe('global');
      expect(loaded.sources).toEqual([{ file, scope: 'user' }]);
    }
  });

  it('uses defaults without creating a file when the new file is absent', () => {
    const { cwd, home, file } = layout();
    fs.writeFileSync(path.join(cwd, 'handsfree.config.json'), JSON.stringify({ orchestration: { provider: 'acp' } }));
    const loaded = loadConfig(cwd, home);
    expect(loaded.sources).toEqual([]);
    expect(loaded.config.workspaceRoot).toBe(path.join(home, '.handsfree'));
    expect(loaded.config.orchestration.provider).toBe('local');
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([[], null, 12])('rejects non-object settings: %s', (raw) => {
    const { cwd, home } = layout(raw);
    expect(() => loadConfig(cwd, home)).toThrow('must hold a JSON object');
  });

  it('names the new file in parse and schema errors', () => {
    const { cwd, home, file } = layout({ orchestration: { provider: 'unknown' } });
    expect(() => loadConfig(cwd, home)).toThrow(`Invalid configuration in ${file}`);
    fs.writeFileSync(file, '{ nope');
    expect(() => loadConfig(cwd, home)).toThrow(`${file} is not valid JSON`);
  });

  it('retains legacy llm fields when updating the new file', () => {
    const { cwd, home } = layout({ llm: { model: 'old', baseURL: 'http://localhost:9999/v1' } });
    const before = modelDefaults(loadConfig(cwd, home).config);
    saveModelDefaults(before, { ...before, local: 'new' }, home);
    const config = loadConfig(cwd, home).config;
    expect(config.orchestration.local.model).toBe('new');
    expect(config.orchestration.local.baseURL).toBe('http://localhost:9999/v1');
  });
});

describe('built-in agents', () => {
  it('fills in the default profiles around whatever the file names', () => {
    const { cwd, home } = layout({ agents: { codex: { model: 'pinned', enabled: false }, custom: { command: 'other' } } });
    const { agents } = loadConfig(cwd, home).config;
    expect(Object.keys(agents).sort()).toEqual(['claude', 'codex', 'custom', 'gemini']);
    // A built-in entry is a delta: what it says wins, the rest is inherited.
    expect(agents.codex).toMatchObject({
      command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'],
      note: 'methodical coding agent, good at tests and refactors', model: 'pinned', enabled: false,
    });
    expect(agents.claude).toEqual(ConfigSchema.parse({}).agents.claude);
    expect(agents.custom).toMatchObject({ command: 'other', args: [], enabled: true });
  });

  it('takes the launch line whole: naming the command drops the default arguments', () => {
    const { cwd, home } = layout({ agents: { gemini: { command: 'gemini-nightly' } } });
    const gemini = loadConfig(cwd, home).config.agents.gemini;
    expect(gemini).toMatchObject({ command: 'gemini-nightly', args: [], note: 'fast, good at bulk text and single-file work' });
  });

  it('refuses arguments without a command, even for a built-in agent', () => {
    const { cwd, home, file } = layout({ agents: { claude: { args: ['--acp'] } } });
    expect(() => loadConfig(cwd, home)).toThrow(`Invalid configuration in ${file}`);
    expect(() => loadConfig(cwd, home)).toThrow('agents.claude.command');
  });

  it('requires a command for an agent the defaults do not know', () => {
    const { cwd, home } = layout({ agents: { custom: { model: 'x' } } });
    expect(() => loadConfig(cwd, home)).toThrow('agents.custom.command');
  });

  it('leaves the schema to judge an entry that is not an object', () => {
    const { cwd, home } = layout({ agents: { codex: 'npx codex-acp' } });
    expect(() => loadConfig(cwd, home)).toThrow('agents.codex');
  });
});

describe('saving model defaults', () => {
  it('ignores legacy native-tool switches and removes them on the next settings save', () => {
    const { cwd, home, file } = layout({
      agents: { codex: { command: 'codex-acp', nativeTools: 'deny', model: 'existing-model' } },
    });
    const config = loadConfig(cwd, home).config;
    expect(config.agents.codex).not.toHaveProperty('nativeTools');
    const before = modelDefaults(config);
    saveModelDefaults(before, { ...before, agents: { codex: 'new-model' } }, home);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).agents.codex)
      .toEqual({ command: 'codex-acp', model: 'new-model' });
  });

  it('creates private settings holding only the changed models, and reloads all four', () => {
    const { cwd, home, file } = layout();
    const before = modelDefaults(loadConfig(cwd, home).config);
    saveModelDefaults(before, {
      ...before, provider: 'acp', agent: 'claude', acp: 'planner-test',
      agents: { claude: 'claude-test', codex: 'codex-test', gemini: 'gemini-test' },
    }, home);
    // No launch line, note or flag is copied in: the defaults stay the defaults.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      orchestration: { provider: 'acp', acp: { model: 'planner-test' } },
      agents: { claude: { model: 'claude-test' }, codex: { model: 'codex-test' }, gemini: { model: 'gemini-test' } },
    });
    const config = loadConfig(cwd, home).config;
    expect(config.orchestration.acp.model).toBe('planner-test');
    expect(config.orchestration.provider).toBe('acp');
    expect(config.agents.claude?.model).toBe('claude-test');
    expect(config.agents.codex?.model).toBe('codex-test');
    expect(config.agents.gemini?.model).toBe('gemini-test');
    expect(config.agents.codex?.command).toBe('npx');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['config.json']);
  });

  it('drops an entry that clearing its model leaves empty', () => {
    const { cwd, home, file } = layout({ cleanupPeriodDays: 7 });
    const before = modelDefaults(loadConfig(cwd, home).config);
    saveModelDefaults(before, { ...before, agents: { ...before.agents, codex: 'test-model' } }, home);
    const pinned = modelDefaults(loadConfig(cwd, home).config);
    saveModelDefaults(pinned, { ...pinned, agents: { ...pinned.agents, codex: '' } }, home);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ cleanupPeriodDays: 7 });
    expect(loadConfig(cwd, home).config.agents.codex?.model).toBeUndefined();
  });

  it('keeps unrelated fields, custom profiles, and disk edits made after opening the screen', () => {
    const raw = {
      orchestration: { provider: 'acp', acp: { agent: 'claude', model: 'planner' }, relayAnswers: true },
      agents: {
        claude: { command: 'custom-launch', args: ['--acp'], env: { SECRET: 'kept' }, model: 'old' },
        custom: { command: 'other', enabled: false },
      },
      roles: { custom: 'specialist' }, extra: { keep: true },
    };
    const { cwd, home, file } = layout(raw);
    const before = modelDefaults(loadConfig(cwd, home).config);
    fs.writeFileSync(file, JSON.stringify({ ...raw, cleanupPeriodDays: 7, roles: { custom: 'edited later' } }));
    saveModelDefaults(before, { ...before, acp: '', agents: { ...before.agents, claude: '' } }, home);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.agents.claude).toEqual({ command: 'custom-launch', args: ['--acp'], env: { SECRET: 'kept' } });
    expect(saved.agents.custom).toEqual(raw.agents.custom);
    expect(saved.orchestration).toEqual({ provider: 'acp', acp: { agent: 'claude' } });
    expect(saved.roles.custom).toBe('edited later');
    expect(saved.cleanupPeriodDays).toBe(7);
    expect(saved.extra).toEqual({ keep: true });
  });

  it('keeps the other default agents when only one model is first saved', () => {
    const { cwd, home, file } = layout();
    const before = modelDefaults(loadConfig(cwd, home).config);
    saveModelDefaults(before, { ...before, agents: { ...before.agents, codex: 'test-model' } }, home);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).agents).toEqual({ codex: { model: 'test-model' } });
    expect(Object.keys(loadConfig(cwd, home).config.agents).sort()).toEqual(['claude', 'codex', 'gemini']);
  });

  it('leaves original bytes untouched when validation fails', () => {
    const { cwd, home, file } = layout({ cleanupPeriodDays: 9 });
    const original = fs.readFileSync(file, 'utf8');
    const before = modelDefaults(loadConfig(cwd, home).config);
    expect(() => saveModelDefaults(before, { ...before, local: ' ' }, home)).toThrow('cannot be empty');
    expect(() => updateConfig((raw) => { raw.cleanupPeriodDays = -1; }, home)).toThrow('Invalid configuration');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('reports a write failure without leaving a temporary file', () => {
    const { home, file } = layout();
    fs.mkdirSync(path.dirname(file));
    fs.mkdirSync(file);
    expect(() => updateConfig(() => {}, home)).toThrow();
    expect(fs.readdirSync(path.dirname(file))).toEqual(['config.json']);
  });
});
