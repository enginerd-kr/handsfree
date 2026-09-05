import { describe, expect, it } from 'vitest';
import { AgentProfileSchema } from '../config/schema.js';
import { mediationProblem } from './mediation.js';

describe('known native adapter mediation', () => {
  it('recognizes scoped, versioned, direct and renamed Codex launch profiles', () => {
    for (const launch of [
      { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@1.10.0'] },
      { command: '/usr/local/bin/codex-acp' },
      { command: 'npx', args: ['@zed-industries/codex-acp'] },
    ]) expect(mediationProblem(AgentProfileSchema.parse(launch))).toContain('disabled before prompting');
    const wrapper = AgentProfileSchema.parse({ command: 'custom-wrapper' });
    expect(mediationProblem(wrapper, '@agentclientprotocol/codex-acp')).toContain('disabled');
    expect(mediationProblem(AgentProfileSchema.parse({ command: 'codex-acp', nativeTools: 'allow' }))).toBeUndefined();
    expect(mediationProblem(AgentProfileSchema.parse({ command: 'gemini' }))).toBeUndefined();
  });
});
