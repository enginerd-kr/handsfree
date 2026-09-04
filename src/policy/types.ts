import type { ToolKind } from '@agentclientprotocol/sdk';
import type { PermissionMode } from './mode.js';

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
  /**
   * Set only when the session's permission mode turned an ask or a denial
   * into this allow. `rule` still names the rule that was overridden.
   */
  mode?: Exclude<PermissionMode, 'ask'>;
}

export interface AuditEntry extends Decision {
  at: number;
  request: PolicyRequest;
  /** One line describing what was being asked for. */
  summary: string;
}

/** What a form field can come back as, in the shapes ACP puts on the wire. */
export type InputValue = string | number | boolean | string[];

/**
 * One thing an agent wants to know. `kind` is the ACP property schema reduced
 * to what a seat has to be able to render: a line of text, a number, a yes/no,
 * one of a list, or several of a list.
 */
export interface InputField {
  key: string;
  label: string;
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multiselect';
  required: boolean;
  description?: string;
  /** For `enum` and `multiselect`, the choices in the order the agent gave them. */
  options?: { value: string; label: string }[];
  default?: InputValue;
}

export interface InputQuestion {
  /** The agent's own sentence: what it needs and why. */
  summary: string;
  fields: InputField[];
  context: RequestContext;
  signal: AbortSignal;
}

/**
 * `decline` is a person saying no; `cancel` is nobody being there to say
 * anything. The agent is told which, because "refused" and "unanswerable" are
 * different things to plan around.
 */
export type InputAnswer =
  | { action: 'accept'; content: Record<string, InputValue> }
  | { action: 'decline' }
  | { action: 'cancel' };

/**
 * The human seat. `ask` answers an `ask` verdict; `input` answers an agent that
 * stopped to ask a question of its own. A seat that cannot take questions
 * leaves `input` undefined, and elicitation is cancelled rather than guessed at.
 * Anything headless leaves both undefined, which means the request is denied.
 */
export interface Escalator {
  ask(question: {
    summary: string;
    detail: string;
    rule: string;
    context: RequestContext;
    signal: AbortSignal;
  }): Promise<boolean>;
  input?(question: InputQuestion): Promise<InputAnswer>;
}
