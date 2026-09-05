import path from 'node:path';
import { Jail } from './jail.js';
import { render } from './exec.js';
import type { PermissionMode } from './mode.js';
import type {
  AuditEntry,
  Decision,
  Escalator,
  InputAnswer,
  InputField,
  PolicyRequest,
  RequestContext,
} from './types.js';

export interface PolicyEngineOptions {
  decisionTimeoutMs: number;
  jail: Jail;
  escalator?: Escalator;
  onDecision?: (entry: AuditEntry) => void;
  now?: () => number;
}

interface Ruling {
  rule: string;
  reason?: string;
}

export interface AskOptions {
  /**
   * The request the question belongs to. When the agent withdraws it — a
   * cancelled turn, a dropped connection — the question goes with it, rather
   * than staying on screen collecting an answer nobody can deliver.
   */
  signal?: AbortSignal;
}

/**
 * One approval path for all host gates. Ask forwards each request to the user;
 * bypass approves it. Request kinds label the audit record without classifying
 * commands or paths against configurable permission rules.
 */
export class PolicyEngine {
  private readonly decisionTimeoutMs: number;
  private readonly jail: Jail;
  private escalator: Escalator | undefined;
  private currentMode: PermissionMode = 'ask';
  private readonly onDecision: ((entry: AuditEntry) => void) | undefined;
  private readonly now: () => number;
  /** Open questions per agent, so a turn can be told to stop its clocks. */
  private readonly waiting = new Map<string, number>();
  private readonly pendingApprovals = new Set<() => void>();
  constructor(options: PolicyEngineOptions) {
    this.decisionTimeoutMs = options.decisionTimeoutMs;
    this.jail = options.jail;
    this.escalator = options.escalator;
    this.onDecision = options.onDecision;
    this.now = options.now ?? Date.now;
  }

  /** The TUI installs itself once it is mounted; before that, `ask` means deny. */
  setEscalator(escalator: Escalator | undefined): void {
    this.escalator = escalator;
  }

  /** Session-only state shared by every gate; bypass also releases pending approvals. */
  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
    if (mode === 'bypass') for (const approve of [...this.pendingApprovals]) approve();
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  async resolve(request: PolicyRequest, options: AskOptions = {}): Promise<Decision> {
    return this.settle(request, { rule: request.kind === 'tool' ? `tool.${request.toolKind ?? 'other'}` : request.kind }, options.signal);
  }

  /** The same approval flow with an explicit scope, such as a session-wide grant. */
  async confirm(
    request: PolicyRequest,
    ruling: { rule: string; reason: string },
    options: AskOptions = {},
  ): Promise<Decision> {
    return this.settle(request, ruling, options.signal);
  }

  /**
   * An agent that stopped to ask the user something. This is not a side effect
   * and no rule judges it; what it borrows from the gates is the seat, the
   * deadline, and the hold that keeps a turn alive while a person is reading.
   * A seat that cannot take questions cancels rather than inventing an answer.
   */
  async elicit(
    context: RequestContext,
    question: { summary: string; fields: InputField[] },
    options: AskOptions = {},
  ): Promise<InputAnswer> {
    const escalator = this.escalator;
    if (!escalator?.input) return { action: 'cancel' };

    const controller = this.deadline(options.signal);
    const release = this.hold(context.agentId);
    try {
      return await Promise.race([
        escalator.input({ ...question, context, signal: controller.signal }),
        aborted(controller.signal).then((): InputAnswer => {
          throw new Error('timed out');
        }),
      ]);
    } catch {
      return { action: 'cancel' };
    } finally {
      controller.done();
      release();
    }
  }

  /**
   * True while a person is being asked something about this agent. A turn's
   * clocks stand still for that: an agent blocked on a question sends no
   * updates, and a timer that cannot tell waiting from wedged will cut the
   * turn down while the user is still reading the question.
   */
  isWaiting(agentId: string): boolean {
    return (this.waiting.get(agentId) ?? 0) > 0;
  }

  private async settle(
    request: PolicyRequest,
    ruling: Ruling,
    signal: AbortSignal | undefined,
  ): Promise<Decision> {
    const summary = request.kind === 'tool' ? request.title : describe(request, this.jail);
    let decision: Decision;
    if (this.currentMode === 'bypass') {
      decision = {
        verdict: 'allow',
        rule: ruling.rule,
        mode: 'bypass',
      };
    } else {
      decision = await this.escalate(request, ruling, summary, signal);
    }

    this.onDecision?.({
      ...decision,
      at: this.now(),
      request,
      summary,
    });
    return decision;
  }

  private async escalate(
    request: PolicyRequest,
    ruling: Ruling,
    summary: string,
    signal: AbortSignal | undefined,
  ): Promise<Decision> {
    const escalator = this.escalator;
    if (!escalator) {
      return {
        verdict: 'deny',
        rule: ruling.rule,
        reason: 'nobody available to approve (ask mode requires an approval interface)',
      };
    }

    const controller = this.deadline(signal);
    const release = this.hold(request.agentId);
    let approve: () => void = () => {};
    const bypassed = new Promise<boolean>((resolve) => { approve = () => resolve(true); });
    this.pendingApprovals.add(approve);
    try {
      // The deadline is enforced here rather than inside the escalator. An
      // escalator that ignores the signal — a wedged UI, a bad implementation —
      // must not be able to hold a permission request open indefinitely.
      const allowed = await Promise.race([
        escalator.ask({
          summary,
          ...(request.kind === 'tool' && request.approvalLabel ? { approvalLabel: request.approvalLabel } : {}),
          detail: [
            ...(request.kind === 'tool' ? [request.rawInput == null ? '' : JSON.stringify(request.rawInput, null, 2), ...request.locations] : []),
            ...(ruling.rule === 'tool.sessionWideOnly' ? [ruling.reason] : []),
          ].filter(Boolean).join('\n'),
          rule: ruling.rule,
          context: { agentId: request.agentId, sessionId: request.sessionId },
          signal: controller.signal,
        }),
        bypassed,
        aborted(controller.signal).then((): boolean => {
          throw new Error('timed out');
        }),
      ]);
      // A yes to a question the mode, as it stands now, would not have asked
      // was the mode switch answering — the seat flushes what it holds when
      // the mode moves — and is written down as the mode's, not a person's.
      const mode = this.currentMode;
      const byMode = allowed && mode === 'bypass';
      return {
        verdict: allowed ? 'allow' : 'deny',
        rule: ruling.rule,
        reason: allowed ? undefined : 'declined',
        escalated: true,
        ...(byMode ? { mode } : {}),
      };
    } catch (err) {
      // A prompt that errors, times out, or is torn down is a denial. Every
      // failure mode in this class has to fall the same way.
      const aborted = controller.signal.aborted;
      return {
        verdict: 'deny',
        rule: ruling.rule,
        reason: aborted ? 'no answer in time' : `escalation failed: ${(err as Error).message}`,
        escalated: true,
      };
    } finally {
      this.pendingApprovals.delete(approve);
      controller.abort();
      controller.done();
      release();
    }
  }

  /**
   * The clock a question is asked under: our own decision timeout, and the
   * caller's signal folded in so a withdrawn request takes its question down
   * with it.
   */
  private deadline(signal: AbortSignal | undefined): {
    signal: AbortSignal;
    done: () => void;
    abort: () => void;
  } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.decisionTimeoutMs);
    const relay = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relay);
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      done: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', relay);
      },
    };
  }

  /** Marks this agent as waiting on a person until the returned call is made. */
  private hold(agentId: string): () => void {
    this.waiting.set(agentId, (this.waiting.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.waiting.get(agentId) ?? 1) - 1;
      if (left > 0) this.waiting.set(agentId, left);
      else this.waiting.delete(agentId);
    };
  }

}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

const PATH_KEY = /^(file_?path|path|notebook_?path|target_file|dir_?path)$/i;

/**
 * Files named inside an agent's own tool input. This is not a nicety: real
 * adapters send a permission request with an empty `locations` array and the
 * path only in `rawInput`, and a path the boundary never sees is a path the
 * boundary never checks.
 */
export function pathsFromRawInput(raw: unknown, depth = 0): string[] {
  if (depth > 4 || !raw || typeof raw !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (PATH_KEY.test(key) && path.isAbsolute(value)) found.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) found.push(...pathsFromRawInput(item, depth + 1));
    } else if (value && typeof value === 'object') {
      found.push(...pathsFromRawInput(value, depth + 1));
    }
  }
  return found;
}

export function describe(request: PolicyRequest, jail?: Jail): string {
  const rel = (target: string) => (jail ? jail.display(target) : path.basename(target));
  switch (request.kind) {
    case 'fs.read':
      return `read ${rel(request.path)}`;
    case 'fs.write':
      return `write ${rel(request.path)} (${request.bytes} bytes)`;
    case 'exec':
      return `run ${render([request.command, ...request.args])}`;
    case 'tool': {
      // Adapters put the absolute path straight into the title, so cutting the
      // paths down has to happen inside the sentence as well as beside it.
      let title = request.title;
      for (const target of request.locations) title = title.split(target).join(rel(target));
      const unnamed = request.locations.map(rel).filter((target) => !title.includes(target));
      return unnamed.length > 0 ? `${title} [${unnamed.join(', ')}]` : title;
    }
  }
}
