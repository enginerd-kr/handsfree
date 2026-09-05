import type { AgentProfile } from '../config/schema.js';

/** Adapters whose tasks need exclusive workspace scheduling, including inspections. */
export function nativeToolAdapter(profile: AgentProfile, name = ''): boolean {
  return /(?:^|[/@])codex-acp(?:$|@|\s)/i.test(name)
    || [profile.command, ...profile.args].some((part) => /(?:^|\/)codex-acp(?:$|@)/i.test(part));
}
