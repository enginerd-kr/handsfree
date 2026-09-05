import type { AgentProfile } from '../config/schema.js';
import type { HostContext } from './capabilities/context.js';
import { AgentConnection, type ConnectionTarget } from './connection.js';
import { fallbackArgs, spawnTarget } from './launch.js';

interface OpenAgentOptions {
  /** Configured agent id; the host may use a separate id for orchestration. */
  agentId: string;
  profile: AgentProfile;
  host: HostContext;
  signal: AbortSignal;
  createTarget?: (agentId: string, profile: AgentProfile) => ConnectionTarget;
}

/** Open a worker or planner connection, retrying renamed adapter flags once. */
export async function openAgent({ agentId, profile, host, signal, createTarget }: OpenAgentOptions): Promise<AgentConnection> {
  const fallback = fallbackArgs(profile.args);
  const attempts = fallback ? [profile.args, fallback] : [profile.args];
  for (const [index, args] of attempts.entries()) {
    signal.throwIfAborted();
    const attempt = { ...profile, args };
    const target = createTarget
      ? createTarget(agentId, attempt)
      : spawnTarget(attempt, {
          cwd: host.workspace.dir,
          env: host.config.env,
          onStderr: (text) => host.transcript.append({ type: 'agent_stderr', agentId: host.agentId, text }),
        });
    try {
      return await AgentConnection.open({ agentId: host.agentId, host, target, signal });
    } catch (error) {
      await target.close();
      if (index === attempts.length - 1) throw error;
    }
  }
  throw new Error(`Could not start ${agentId}.`);
}
