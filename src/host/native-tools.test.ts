import { describe, expect, it } from 'vitest';
import { AgentProfileSchema, ConfigSchema } from '../config/schema.js';
import { nativeToolAdapter } from './native-tools.js';

describe('native adapter scheduling identity', () => {
  it('identifies the bundled Codex profile without an execution switch', () => {
    const profile = ConfigSchema.parse({}).agents.codex!;
    expect(nativeToolAdapter(profile)).toBe(true);
    expect(profile).not.toHaveProperty('nativeTools');
  });

  it('recognizes scoped, versioned, direct and renamed Codex launch profiles', () => {
    for (const launch of [
      { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@1.10.0'] },
      { command: '/usr/local/bin/codex-acp' },
      { command: 'npx', args: ['@zed-industries/codex-acp'] },
    ]) expect(nativeToolAdapter(AgentProfileSchema.parse(launch))).toBe(true);
    const wrapper = AgentProfileSchema.parse({ command: 'custom-wrapper' });
    expect(nativeToolAdapter(wrapper, '@agentclientprotocol/codex-acp')).toBe(true);
    expect(nativeToolAdapter(AgentProfileSchema.parse({ command: 'gemini' }))).toBe(false);
  });
});
