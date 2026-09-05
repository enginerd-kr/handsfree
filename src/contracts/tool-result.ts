import type { SharedContextSelection } from './shared-context.js';

/** Facts about a tool invocation, not an assessment of the user's objective. */
export interface ToolReceipt {
  status: 'ok' | 'error' | 'pending' | 'cancelled';
  /** null means an exception left execution uncertain; never assume no side effects. */
  executed: boolean | null;
  created_tasks: string[];
  observed_tasks?: string[];
  job?: string;
  record?: string;
  /** The prefix actually selected, distinct from later replies now available. */
  shared_context?: SharedContextSelection;
  conversation_head?: SharedContextSelection;
  error?: { code: string; message: string; valid_refs?: string[] };
}
