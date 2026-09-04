import { describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  ConfigSchema,
  agentRole,
  assertLaunchArgsAllowed,
  orchestrationModel,
} from './schema.js';

describe('launch arguments', () => {
  it.each([
    ['--dangerously-skip-permissions'],
    ['--yolo'],
    ['--sandbox=danger-full-access'],
    ['--permission-mode'],
    ['--approval-mode'],
  ])('refuses %s', (arg) => {
    expect(() => assertLaunchArgsAllowed([arg], 'test')).toThrow(/Refusing launch argument/);
  });

  it('refuses gemini yolo while leaving npx -y alone', () => {
    expect(() => assertLaunchArgsAllowed(['-y'], 'test', 'gemini')).toThrow(/Refusing/);
    expect(() => assertLaunchArgsAllowed(['-y', '@zed-industries/codex-acp'], 'test', 'npx'))
      .not.toThrow();
  });

  it('allows ordinary adapter flags', () => {
    expect(() => assertLaunchArgsAllowed(['--experimental-acp', '-m', 'gemini-3.5-flash'], 'test'))
      .not.toThrow();
  });

  it('refuses them through config too', () => {
    const parsed = ConfigSchema.safeParse({
      agents: { claude: { command: 'claude', args: ['--dangerously-skip-permissions'] } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('defaults', () => {
  it('ships the three known adapters', () => {
    const config = ConfigSchema.parse({});
    expect(Object.keys(config.agents)).toEqual(['claude', 'gemini', 'codex']);
    expect(config.agents['gemini']?.args).toContain('--acp');
    // All three are on by default; an adapter you have not installed fails at
    // the handshake, which `doctor` reports, rather than being hidden here.
    expect(Object.values(config.agents).every((agent) => agent.enabled)).toBe(true);
    // The adapters the ACP registry names as canonical, not the retired ones.
    expect(config.agents['claude']?.args).toContain('@agentclientprotocol/claude-agent-acp');
    expect(config.agents['codex']?.args).toContain('@agentclientprotocol/codex-acp');
    // None pins a model: each adapter is the CLI's own, so the roster and the
    // default it comes up on are the CLI's, and repeating them here would only
    // be a copy to go stale.
    for (const agent of Object.values(config.agents)) expect(agent.model).toBeUndefined();
  });

  it('takes an optional model override, and nothing else about models', () => {
    const parsed = AgentProfileSchema.parse({ command: 'agent', model: 'opus[1m]' });
    expect(parsed.model).toBe('opus[1m]');
    expect(AgentProfileSchema.parse({ command: 'agent' }).model).toBeUndefined();
    expect(AgentProfileSchema.safeParse({ command: 'agent', model: '' }).success).toBe(false);
  });

  it('keeps the planner’s own name free of agents', () => {
    // `@orchestrator:agent:model` moves the planner; an agent wearing the name
    // could never be addressed, and the mention would mean two things at once.
    const parsed = ConfigSchema.safeParse({ agents: { orchestrator: { command: 'agent' } } });
    expect(parsed.success).toBe(false);
  });

  it('arrives able to run a coding task, and says what needs no person', () => {
    const config = ConfigSchema.parse({});
    expect(config.capabilities.terminal).toBe(true);
    expect(config.policy.exec.enabled).toBe(true);
    expect(config.policy.exec.allow).toContain('pnpm test');
    // On the list runs silently; off it is a question; outside the workspace is
    // neither, whatever the list says.
    expect(config.policy.exec.otherwise).toBe('ask');
    expect(config.policy.fs.outside).toBe('deny');
  });

  it('replaces the agent list wholesale when one is given', () => {
    const config = ConfigSchema.parse({ agents: { local: { command: 'my-agent' } } });
    expect(Object.keys(config.agents)).toEqual(['local']);
    expect(config.agents['local']?.enabled).toBe(true);
  });
});

describe('env', () => {
  it('defaults to inheriting everything', () => {
    const config = ConfigSchema.parse({});
    expect(config.env).toEqual({});
  });

  it('takes variables by their own names, with null meaning remove', () => {
    const config = ConfigSchema.parse({
      env: { HTTPS_PROXY: 'http://proxy.corp:8080', NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem', HTTP_PROXY: null },
    });
    expect(config.env['HTTPS_PROXY']).toBe('http://proxy.corp:8080');
    expect(config.env['NODE_EXTRA_CA_CERTS']).toBe('/etc/ssl/corp.pem');
    expect(config.env['HTTP_PROXY']).toBeNull();
    expect(config.env['NO_PROXY']).toBeUndefined();
  });

  it('lets an agent profile null out an inherited variable', () => {
    const config = ConfigSchema.parse({
      agents: { claude: { command: 'agent', env: { HTTPS_PROXY: null } } },
    });
    expect(config.agents['claude']?.env['HTTPS_PROXY']).toBeNull();
  });
});

describe('roles', () => {
  it('starts empty, so an agent is described by its profile note', () => {
    const config = ConfigSchema.parse({});
    expect(config.roles).toEqual({});
    expect(agentRole(config, 'codex')).toBe('methodical coding agent, good at tests and refactors');
  });

  it('overrides the profile note when one is written', () => {
    const config = ConfigSchema.parse({ roles: { codex: 'all test work in this repo' } });
    expect(agentRole(config, 'codex')).toBe('all test work in this repo');
    // Only the agent it named: the others keep the note they shipped with.
    expect(agentRole(config, 'gemini')).toBe('fast, good at bulk text and single-file work');
  });

  it('says nothing about an agent nobody described', () => {
    const config = ConfigSchema.parse({ agents: { local: { command: 'my-agent' } } });
    expect(agentRole(config, 'local')).toBe('');
    expect(agentRole(config, 'absent')).toBe('');
  });

  it('refuses a role for an agent that is not configured', () => {
    // Dropping it silently would read exactly like a role the planner ignored.
    const parsed = ConfigSchema.safeParse({ roles: { aider: 'the one that is not here' } });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toMatch(
      /no such agent is configured/,
    );
  });

  it('refuses an empty role rather than treating it as a role', () => {
    expect(ConfigSchema.safeParse({ roles: { codex: '' } }).success).toBe(false);
  });
});

describe('orchestration', () => {
  it('defaults to the local provider with both blocks filled in', () => {
    const config = ConfigSchema.parse({});
    expect(config.orchestration.provider).toBe('local');
    expect(config.orchestration.local.baseURL).toBe('http://localhost:1234/v1');
    expect(config.orchestration.acp.agent).toBe('claude');
  });

  it('accepts the acp provider when it names a configured agent', () => {
    const parsed = ConfigSchema.safeParse({ orchestration: { provider: 'acp' } });
    expect(parsed.success).toBe(true);
  });

  it('refuses the acp provider when its agent is not configured', () => {
    const parsed = ConfigSchema.safeParse({
      orchestration: { provider: 'acp', acp: { agent: 'nope' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('leaves the planner on the agent default when nobody names a model', () => {
    expect(orchestrationModel(ConfigSchema.parse({ orchestration: { provider: 'acp' } })))
      .toBeUndefined();
  });

  it('plans on the model orchestration names', () => {
    const config = ConfigSchema.parse({
      orchestration: { provider: 'acp', acp: { agent: 'claude', model: 'haiku' } },
    });
    expect(config.orchestration.acp.model).toBe('haiku');
    expect(orchestrationModel(config)).toBe('haiku');
    expect(
      ConfigSchema.safeParse({ orchestration: { acp: { model: '' } } }).success,
    ).toBe(false);
  });

  it('falls back to the profile of the agent it plans through', () => {
    const config = ConfigSchema.parse({
      orchestration: { provider: 'acp', acp: { agent: 'claude' } },
      agents: { claude: { command: 'claude', model: 'opus[1m]' } },
    });
    expect(orchestrationModel(config)).toBe('opus[1m]');
  });

  it('lets orchestration disagree with that profile', () => {
    const config = ConfigSchema.parse({
      orchestration: { provider: 'acp', acp: { agent: 'claude', model: 'haiku' } },
      agents: { claude: { command: 'claude', model: 'opus[1m]' } },
    });
    expect(orchestrationModel(config)).toBe('haiku');
  });
});
