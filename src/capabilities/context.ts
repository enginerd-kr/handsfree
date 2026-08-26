import type { Config } from '../config/schema.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { Jail } from '../policy/jail.js';
import type { Transcript } from '../workspace/transcript.js';
import type { Workspace } from '../workspace/workspace.js';

/** Everything a client-side handler needs, fixed for the life of a connection. */
export interface HostContext {
  agentId: string;
  config: Config;
  workspace: Workspace;
  jail: Jail;
  policy: PolicyEngine;
  transcript: Transcript;
}
