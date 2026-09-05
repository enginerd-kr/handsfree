import type { AgentProfile } from '../config/schema.js';

/** Known incompatibilities, not an attestation that all other adapters are safe. */
export function nativeToolAdapter(profile: AgentProfile, name = ''): boolean {
  return /(?:^|[/@])codex-acp(?:$|@|\s)/i.test(name)
    || [profile.command, ...profile.args].some((part) => /(?:^|\/)codex-acp(?:$|@)/i.test(part));
}

export function mediationProblem(profile: AgentProfile, name?: string): string | undefined {
  if (nativeToolAdapter(profile, name) && profile.nativeTools !== 'allow') {
    return 'Codex ACP runs native tools outside host policy mediation. Execution is disabled before prompting. '
      + 'Use a host-mediated adapter, or set this agent profile nativeTools to allow only when accepting adapter-native permissions or using external isolation.';
  }
  return undefined;
}
