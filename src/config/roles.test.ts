import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentsConfigPath, configPath, loadConfig, updateConfig } from './load.js';
import { agentRole } from './schema.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function setup(roles: unknown, config: unknown = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-roles-'));
  homes.push(home);
  fs.mkdirSync(path.join(home, '.handsfree'));
  fs.writeFileSync(agentsConfigPath(home), JSON.stringify(roles));
  fs.writeFileSync(configPath(home), JSON.stringify(config));
  return home;
}

describe('shared agent roles with global model settings', () => {
  it('applies standalone overrides by agent name across projects and keeps them separate when saving settings', () => {
    const home = setup({ codex: '테스트와 리팩터링', reviewer: 'Independent review' }, {
      roles: { codex: 'Global role', claude: 'Architecture' }, agents: { reviewer: { command: 'review-agent' } },
    });
    for (const project of ['one', 'two']) {
      const { config, sources } = loadConfig(path.join(home, project), home);
      expect(agentRole(config, 'codex')).toBe('테스트와 리팩터링');
      expect(agentRole(config, 'claude')).toBe('Architecture');
      expect(agentRole(config, 'reviewer')).toBe('Independent review');
      expect(config.agents.codex?.command).toBe('npx');
      expect(sources.map((source) => source.file)).toEqual([agentsConfigPath(home), configPath(home)]);
    }
    updateConfig((raw, config) => {
      expect(agentRole(config, 'codex')).toBe('테스트와 리팩터링');
      raw.agents = { ...(raw.agents as object), codex: { model: 'chosen' } };
    }, home);
    expect(JSON.parse(fs.readFileSync(configPath(home), 'utf8')).roles.codex).toBe('Global role');
    expect(loadConfig(home, home).config.agents.codex?.model).toBe('chosen');
    expect(agentRole(loadConfig(home, home).config, 'codex')).toBe('테스트와 리팩터링');
  });

  it.each([null, [], { codex: '' }, { codex: 42 }, { codex: { role: 'Review' } }, { missing: 'Review' }])(
    'reports invalid standalone roles with their source: %j', (roles) => {
      const home = setup(roles);
      expect(() => loadConfig(home, home)).toThrow(/agents\.json/);
      expect(() => updateConfig(() => {}, home)).toThrow(/agents\.json/);
    },
  );

  it('reports malformed JSON and preserves default roles for an empty standalone map', () => {
    const home = setup({});
    expect(agentRole(loadConfig(home, home).config, 'codex')).toBe('methodical coding agent, good at tests and refactors');
    fs.writeFileSync(agentsConfigPath(home), '{ nope');
    expect(() => loadConfig(home, home)).toThrow(/agents\.json is not valid JSON/);
  });
});
