import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, loadConfig } from './load.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A project directory and a home directory, neither of them the machine's own. */
function layout(files: { project?: unknown; user?: unknown }): { cwd: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-config-'));
  made.push(root);
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.config', 'handsfree'), { recursive: true });
  if (files.project !== undefined) {
    fs.writeFileSync(path.join(cwd, CONFIG_FILENAME), JSON.stringify(files.project));
  }
  if (files.user !== undefined) {
    fs.writeFileSync(
      path.join(home, '.config', 'handsfree', 'config.json'),
      JSON.stringify(files.user),
    );
  }
  return { cwd, home };
}

describe('layering', () => {
  it.each(['user', 'project'] as const)('allows native tools in existing %s profiles that omit the setting', (scope) => {
    const { cwd, home } = layout({
      [scope]: { agents: {
        codex: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
        custom: { command: 'custom-wrapper' },
        blocked: { command: 'codex-acp', nativeTools: 'deny' },
      } },
    });
    const { config } = loadConfig(cwd, home);
    expect(config.agents.codex?.nativeTools).toBe('allow');
    expect(config.agents.custom?.nativeTools).toBe('allow');
    expect(config.agents.blocked?.nativeTools).toBe('deny');
  });

  it('reads the user file when there is no project one', () => {
    const { cwd, home } = layout({ user: { orchestration: { local: { model: 'mine' } } } });
    const { config, sources } = loadConfig(cwd, home);
    expect(config.orchestration.local.model).toBe('mine');
    expect(sources.map((source) => source.scope)).toEqual(['user']);
  });

  it('merges a project file over the user one, key by key', () => {
    const { cwd, home } = layout({
      user: {
        orchestration: { local: { baseURL: 'http://localhost:9999/v1', model: 'mine' } },
        execution: { terminal: { outputByteLimit: 2048, timeoutMs: 5000 } },
      },
      project: {
        orchestration: { local: { model: 'theirs' } },
        execution: { terminal: { timeoutMs: 1000 } },
      },
    });
    const { config, sources } = loadConfig(cwd, home);
    // The project spoke, so it wins the key it named…
    expect(config.orchestration.local.model).toBe('theirs');
    expect(config.execution.terminal.timeoutMs).toBe(1000);
    // …and everything it stayed quiet about is still the user's.
    expect(config.orchestration.local.baseURL).toBe('http://localhost:9999/v1');
    expect(config.execution.terminal.outputByteLimit).toBe(2048);
    expect(sources.map((source) => source.scope)).toEqual(['project', 'user']);
  });

  it('replaces an array rather than adding to it', () => {
    const { cwd, home } = layout({
      user: { execution: { terminal: { env: ['PATH', 'HOME'] } } },
      project: { execution: { terminal: { env: ['PATH'] } } },
    });
    const { config } = loadConfig(cwd, home);
    expect(config.execution.terminal.env).toEqual(['PATH']);
  });

  it('takes an agent profile whole, and keeps the ones the project did not name', () => {
    const { cwd, home } = layout({
      user: {
        agents: {
          gemini: { command: 'gemini', args: ['--experimental-acp', '-m', 'old'], note: 'mine' },
          codex: { command: 'codex', args: [] },
        },
      },
      project: { agents: { gemini: { command: 'gemini', args: ['--experimental-acp'] } } },
    });
    const { config } = loadConfig(cwd, home);
    // No splicing: the profile is the one the project wrote, not a mixture.
    expect(config.agents['gemini']?.args).toEqual(['--experimental-acp']);
    expect(config.agents['gemini']?.note).toBe('');
    expect(config.agents['codex']?.command).toBe('codex');
  });

  it('layers roles name by name, where a profile is taken whole', () => {
    const { cwd, home } = layout({
      user: { roles: { claude: 'mine', gemini: 'bulk text' } },
      project: { roles: { claude: 'this checkout only' } },
    });
    const { config } = loadConfig(cwd, home);
    // The project spoke for claude and stayed quiet about gemini, and unlike an
    // `agents` profile that leaves the user's other line standing.
    expect(config.roles).toEqual({ claude: 'this checkout only', gemini: 'bulk text' });
    // …and it did not have to restate the launch line to say it.
    expect(config.agents['claude']?.command).toBe('npx');
  });

  it('validates the merged whole, so a layer may be a fragment', () => {
    const { cwd, home } = layout({
      user: { agents: { local: { command: 'my-agent' } } },
      project: { orchestration: { provider: 'acp', acp: { agent: 'local' } } },
    });
    const { config } = loadConfig(cwd, home);
    expect(config.orchestration.provider).toBe('acp');
    expect(config.orchestration.acp.agent).toBe('local');
  });

  it('names every file that contributed when the result does not validate', () => {
    const { cwd, home } = layout({
      user: { agents: { local: { command: 'my-agent' } } },
      project: { orchestration: { provider: 'acp', acp: { agent: 'missing' } } },
    });
    expect(() => loadConfig(cwd, home)).toThrow(/handsfree\.config\.json over .*config\.json/s);
  });

  it('falls back to defaults, from nowhere, when neither file exists', () => {
    const { cwd, home } = layout({});
    const { config, sources } = loadConfig(cwd, home);
    expect(sources).toEqual([]);
    expect(config.orchestration.provider).toBe('local');
  });

  it('names the file that is not valid JSON', () => {
    const { cwd, home } = layout({ project: {} });
    fs.writeFileSync(path.join(cwd, CONFIG_FILENAME), '{ nope');
    expect(() => loadConfig(cwd, home)).toThrow(/handsfree\.config\.json is not valid JSON/);
  });
});

describe('legacy policy resources', () => {
  it('keeps resource settings while discarding permission rules', () => {
    const { cwd, home } = layout({ project: { policy: {
      workspaceOnly: true, fs: { write: 'deny', outside: 'deny' }, escalation: [],
      exec: { enabled: false, mode: 'deny', allow: [], shellOperators: 'deny',
        timeoutMs: 4321, outputByteLimit: 2048, env: ['PATH'] },
      decisionTimeoutMs: 1234,
    } } });
    const { config } = loadConfig(cwd, home);
    expect(config).not.toHaveProperty('policy');
    expect(config.execution.terminal).toEqual({ timeoutMs: 4321, outputByteLimit: 2048, env: ['PATH'] });
    expect(config.limits.decisionTimeoutMs).toBe(1234);
    expect(config.capabilities.terminal).toBe(true);
  });

  it('prefers current names within a file and preserves project precedence across names', () => {
    const { cwd, home } = layout({
      user: { execution: { terminal: { timeoutMs: 1000, env: ['HOME'] } }, limits: { decisionTimeoutMs: 1000 } },
      project: {
        policy: { exec: { timeoutMs: 2000, env: ['PATH'] }, decisionTimeoutMs: 2000 },
        execution: { terminal: { timeoutMs: 3000 } },
      },
    });
    const { config } = loadConfig(cwd, home);
    expect(config.execution.terminal.timeoutMs).toBe(3000);
    expect(config.execution.terminal.env).toEqual(['PATH']);
    expect(config.limits.decisionTimeoutMs).toBe(2000);
  });
});

describe('legacy llm block', () => {
  it('is read as orchestration.local', () => {
    const { cwd, home } = layout({
      project: {
        llm: { baseURL: 'http://localhost:9999/v1', model: 'legacy', maxHistoryMessages: 7 },
      },
    });
    const { config } = loadConfig(cwd, home);
    expect(config.orchestration.provider).toBe('local');
    expect(config.orchestration.local.baseURL).toBe('http://localhost:9999/v1');
    expect(config.orchestration.local.model).toBe('legacy');
    expect(config.orchestration.maxHistoryMessages).toBe(7);
  });

  it('yields to an orchestration block in the same file', () => {
    const { cwd, home } = layout({
      project: { llm: { model: 'legacy' }, orchestration: { provider: 'acp' } },
    });
    const { config } = loadConfig(cwd, home);
    expect(config.orchestration.provider).toBe('acp');
    expect(config.orchestration.local.model).toBe('google/gemma-3-12b');
  });

  it('is translated per file, so an old user file layers under a new project one', () => {
    const { cwd, home } = layout({
      user: { llm: { baseURL: 'http://localhost:9999/v1', model: 'legacy' } },
      project: { orchestration: { local: { model: 'current' } } },
    });
    const { config } = loadConfig(cwd, home);
    expect(config.orchestration.local.model).toBe('current');
    expect(config.orchestration.local.baseURL).toBe('http://localhost:9999/v1');
  });
});
