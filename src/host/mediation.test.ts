import { describe, expect, it } from 'vitest';
import { AgentProfileSchema, ConfigSchema } from '../config/schema.js';
import { mediationProblem } from './mediation.js';

describe('known native adapter mediation', () => {
  it('runs the bundled Codex profile while honoring an explicit deny', () => {
    const profile = ConfigSchema.parse({}).agents.codex!;
    expect(mediationProblem(profile)).toBeUndefined();
    expect(mediationProblem(profile, '@agentclientprotocol/codex-acp')).toBeUndefined();
    expect(mediationProblem({ ...profile, nativeTools: 'deny' })).toContain('disabled before prompting');
  });

  it('recognizes scoped, versioned, direct and renamed Codex launch profiles', () => {
    for (const launch of [
      { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@1.10.0'] },
      { command: '/usr/local/bin/codex-acp' },
      { command: 'npx', args: ['@zed-industries/codex-acp'] },
    ]) {
      expect(mediationProblem(AgentProfileSchema.parse(launch))).toBeUndefined();
      expect(mediationProblem(AgentProfileSchema.parse({ ...launch, nativeTools: 'deny' }))).toContain('disabled before prompting');
    }
    const wrapper = AgentProfileSchema.parse({ command: 'custom-wrapper' });
    expect(mediationProblem(wrapper, '@agentclientprotocol/codex-acp')).toBeUndefined();
    expect(mediationProblem({ ...wrapper, nativeTools: 'deny' }, '@agentclientprotocol/codex-acp')).toContain('disabled');
    expect(mediationProblem(AgentProfileSchema.parse({ command: 'codex-acp', nativeTools: 'allow' }))).toBeUndefined();
    expect(mediationProblem(AgentProfileSchema.parse({ command: 'gemini' }))).toBeUndefined();
  });
});
