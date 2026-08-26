import { describe, expect, it } from 'vitest';
import { ConfigSchema, assertLaunchArgsAllowed } from './schema.js';

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
    expect(config.agents['gemini']?.args).toContain('--experimental-acp');
  });

  it('keeps command execution off until it is asked for', () => {
    const config = ConfigSchema.parse({});
    expect(config.capabilities.terminal).toBe(false);
    expect(config.policy.exec.enabled).toBe(false);
    expect(config.policy.fs.outside).toBe('deny');
  });

  it('replaces the agent list wholesale when one is given', () => {
    const config = ConfigSchema.parse({ agents: { local: { command: 'my-agent' } } });
    expect(Object.keys(config.agents)).toEqual(['local']);
    expect(config.agents['local']?.enabled).toBe(true);
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
});
