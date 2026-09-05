import type { SharedContextSelection } from './shared-context.js';

export interface AgentJobInput {
  agent: string | string[];
  prompt: string;
  kind: 'answer' | 'inspect' | 'change';
  model?: string | undefined;
  description?: string | undefined;
  context_from?: string[];
  shared_context?: SharedContextSelection | null;
}
export type AgentJobStatus = 'running' | 'done' | 'cancelled' | 'error' | 'interrupted';
export interface AgentJobRecord {
  jobId: number;
  input: AgentJobInput;
  status: AgentJobStatus;
  text: string;
  taskIds: number[];
  receipt?: ToolReceipt;
}
import type { ToolReceipt } from './tool-result.js';
