import type { Config } from './schema.js';
import { isRecord, updateConfig } from './load.js';

export interface ModelDefaults {
  provider: Config['orchestration']['provider'];
  agent: string;
  local: string;
  acp: string;
  agents: Record<string, string>;
}

export function modelDefaults(config: Config): ModelDefaults {
  return {
    provider: config.orchestration.provider,
    agent: config.orchestration.acp.agent,
    local: config.orchestration.local.model,
    acp: config.orchestration.acp.model ?? '',
    agents: Object.fromEntries(Object.entries(config.agents).map(([id, profile]) => [id, profile.model ?? ''])),
  };
}

/** Apply only the fields edited in this screen, leaving newer disk edits intact. */
export function saveModelDefaults(before: ModelDefaults, next: ModelDefaults, home?: string): string {
  return updateConfig((raw, config) => {
    const object = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
      if (!isRecord(parent[key])) parent[key] = {};
      return parent[key] as Record<string, unknown>;
    };
    if (before.provider !== next.provider) object(raw, 'orchestration').provider = next.provider;
    if (before.agent !== next.agent) object(object(raw, 'orchestration'), 'acp').agent = next.agent;
    if (before.local !== next.local) {
      const model = next.local.trim();
      if (!model) throw new Error('The endpoint model cannot be empty.');
      object(object(raw, 'orchestration'), 'local').model = model;
    }
    if (before.acp !== next.acp) {
      const acp = object(object(raw, 'orchestration'), 'acp');
      if (next.acp.trim()) acp.model = next.acp.trim();
      else delete acp.model;
    }
    for (const [id, value] of Object.entries(next.agents)) {
      if (before.agents[id] === value) continue;
      if (!config.agents[id]) throw new Error(`Agent "${id}" is no longer configured. Reopen /models.`);
      // The file holds deltas over the built-in profiles, so a model is the
      // only key a built-in agent's entry needs — and an entry left with no
      // keys says nothing, so it goes.
      const agents = object(raw, 'agents');
      const profile = object(agents, id);
      if (value.trim()) profile.model = value.trim();
      else delete profile.model;
      if (Object.keys(profile).length === 0) delete agents[id];
      if (Object.keys(agents).length === 0) delete raw.agents;
    }
    if (next.provider === 'acp' && !config.agents[next.agent]?.enabled) {
      throw new Error(`Choose an enabled orchestrator agent; "${next.agent}" is unavailable.`);
    }
  }, home);
}
