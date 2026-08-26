import type { ToolKind } from '@agentclientprotocol/sdk';

export interface RequestContext {
  agentId: string;
  sessionId: string;
}

export type PolicyRequest =
  | ({ kind: 'fs.read'; path: string } & RequestContext)
  | ({ kind: 'fs.write'; path: string; bytes: number } & RequestContext)
  | ({ kind: 'exec'; command: string; args: string[]; cwd: string | undefined } & RequestContext)
  | ({
      kind: 'tool';
      toolKind: ToolKind | null | undefined;
      title: string;
      locations: string[];
      rawInput: unknown;
    } & RequestContext);

export interface Decision {
  verdict: 'allow' | 'deny';
  /** Which rule decided, e.g. `fs.write` or `exec.allow:git status`. */
  rule: string;
  reason?: string;
  /** True when a human (rather than a rule) made the call. */
  escalated?: boolean;
}

export interface AuditEntry extends Decision {
  at: number;
  request: PolicyRequest;
  /** One line describing what was being asked for. */
  summary: string;
}

/**
 * Answers an `ask` verdict. The TUI implements this by prompting; anything
 * headless leaves it undefined, which means the request is denied.
 */
export interface Escalator {
  ask(question: {
    summary: string;
    detail: string;
    rule: string;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<boolean>;
}
