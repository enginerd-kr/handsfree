import path from 'node:path';
import type { ToolKind } from '@agentclientprotocol/sdk';
import type { Policy, RuleOutcome } from '../config/schema.js';
import { Jail } from './jail.js';
import { checkExec, render, scanScript } from './exec.js';
import { applyMode, type PermissionMode } from './mode.js';
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
  policy: Policy;
  jail: Jail;
  escalator?: Escalator;
  onDecision?: (entry: AuditEntry) => void;
  now?: () => number;
}

interface Ruling {
  outcome: RuleOutcome;
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
 * bypass approves it. Legacy rule classifications remain on the audit record
 * for continuity, but never decide whether an operation is allowed.
 */
export class PolicyEngine {
  private readonly policy: Policy;
  private readonly jail: Jail;
  private escalator: Escalator | undefined;
  private currentMode: PermissionMode = 'ask';
  private readonly onDecision: ((entry: AuditEntry) => void) | undefined;
  private readonly now: () => number;
  /** Open questions per agent, so a turn can be told to stop its clocks. */
  private readonly waiting = new Map<string, number>();
  private readonly pendingApprovals = new Set<() => void>();
  constructor(options: PolicyEngineOptions) {
    this.policy = options.policy;
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
    return this.settle(request, this.rule(request), options.signal);
  }

  /** The same approval flow with an explicit scope, such as a session-wide grant. */
  async confirm(
    request: PolicyRequest,
    ruling: { rule: string; reason: string },
    options: AskOptions = {},
  ): Promise<Decision> {
    return this.settle(request, { outcome: 'ask', ...ruling }, options.signal);
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
    // The mode has its say here, on the ruling and before anyone is asked, so
    // there is no window between the rule and the question for it to fall in.
    // The rule keeps its own name either way: a decision the mode made still
    // says which rule it overrode.
    const mode = this.currentMode;
    const ruled = applyMode(mode, ruling);

    let decision: Decision;
    if (ruled.outcome === 'allow') {
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
      const byMode = allowed && mode !== 'ask' && applyMode(mode, ruling).outcome === 'allow';
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
    const timer = setTimeout(() => controller.abort(), this.policy.decisionTimeoutMs);
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

  /** Legacy classification is retained only as audit metadata. */
  private rule(request: PolicyRequest): Ruling {
    switch (request.kind) {
      case 'fs.read':
        return this.fsRule(request.path, this.policy.fs.read, 'fs.read');
      case 'fs.write':
        return this.fsRule(request.path, this.policy.fs.write, 'fs.write');
      case 'exec':
        return this.execRule(request.command, request.args, request.cwd);
      case 'tool':
        return this.toolRule(request);
    }
  }

  private fsRule(target: string, configured: RuleOutcome, rule: string): Ruling {
    const verdict = this.jail.check(target);
    if (!verdict.ok) {
      const outside = this.policy.fs.outside;
      return {
        outcome: this.policy.workspaceOnly ? (outside === 'allow' ? 'allow' : outside) : configured,
        rule: `${rule}.outside`,
        reason: verdict.reason,
      };
    }
    return { outcome: configured, rule, reason: configured === 'allow' ? undefined : target };
  }

  private execRule(command: string, args: string[], cwd: string | undefined): Ruling {
    if (!this.policy.exec.enabled) {
      return {
        outcome: 'deny',
        rule: 'exec.disabled',
        reason: 'running commands is switched off for this workspace',
      };
    }
    if (cwd !== undefined) {
      const verdict = this.jail.check(cwd);
      if (!verdict.ok) {
        return { outcome: 'deny', rule: 'exec.cwd', reason: verdict.reason };
      }
    }
    const check = checkExec(
      { command, args },
      {
        mode: this.policy.exec.mode,
        allow: this.policy.exec.allow,
        otherwise: this.policy.exec.otherwise,
        shellOperators: this.policy.exec.shellOperators,
        // `cd` somewhere inside the workspace changes nothing the boundary
        // cares about; `cd` anywhere else is a command nobody allowed.
        allowCd: (dir) => this.jail.check(path.resolve(this.jail.primaryRoot, dir)).ok,
      },
    );
    if (check.outcome === 'allow') return { outcome: 'allow', rule: check.rule };
    return { outcome: check.outcome, rule: check.rule, reason: check.reason };
  }

  /**
   * A `session/request_permission` carries a tool call rather than an operation,
   * so it is translated into the same terms as the other two gates and judged by
   * the same rules. What cannot be translated is escalated, never assumed.
   */
  private toolRule(request: Extract<PolicyRequest, { kind: 'tool' }>): Ruling {
    for (const location of request.locations) {
      const verdict = this.jail.check(location);
      if (!verdict.ok && this.policy.workspaceOnly) {
        return { outcome: this.policy.fs.outside, rule: 'tool.outside', reason: verdict.reason };
      }
    }

    // A tool call that names a runnable command is judged as one whatever the
    // adapter chose to call it. codex labels a shell call by what it thinks the
    // command means — `ls` arrives as `search` — and a command judged by the
    // read rules is a command that never met the allowlist. The label is the
    // agent's opinion; the argv is the fact. The two kinds refused outright keep
    // their own answer, which is a denial either way but a clearer one.
    if (request.toolKind !== 'fetch' && request.toolKind !== 'switch_mode') {
      const named = commandFromRawInput(request.rawInput);
      if (named) return this.execRule(named.command, named.args, undefined);
    }

    switch (request.toolKind ?? infer(request)) {
      case 'think':
        return { outcome: 'allow', rule: 'tool.think' };
      case 'fetch':
        return {
          outcome: 'deny',
          rule: 'tool.fetch',
          reason: 'network access is outside the workspace',
        };
      case 'switch_mode':
        return {
          outcome: 'deny',
          rule: 'tool.switchMode',
          reason: 'the approval mode is handsfree’s to set, not the agent’s',
        };
      case 'read':
      case 'search':
        if (request.locations.length === 0) {
          return { outcome: this.unknownTarget(), rule: 'tool.unknownTarget', reason: request.title };
        }
        return { outcome: this.policy.fs.read, rule: 'tool.read', reason: request.title };
      case 'edit':
      case 'delete':
      case 'move':
        if (request.locations.length === 0) {
          return { outcome: this.unknownTarget(), rule: 'tool.unknownTarget', reason: request.title };
        }
        return { outcome: this.policy.fs.write, rule: 'tool.write', reason: request.title };
      case 'execute': {
        // gemini sends no input at all, for a shell call or any other; what it
        // sends is the title, and for a shell call the title is the command
        // itself — the description only when the command runs long. The title
        // is judged as the command, then: it is the agent's word, but so is a
        // rawInput. What cannot be read as a command is put to a person,
        // who is shown the title and knows more than a parser does.
        const command = commandFromRawInput(request.rawInput) ?? commandFromTitle(request.title);
        if (!command) {
          return {
            outcome: this.unknownTarget(),
            rule: 'tool.opaqueCommand',
            reason: 'the agent did not say what it would run in a form handsfree can check',
          };
        }
        return this.execRule(command.command, command.args, undefined);
      }
      default:
        return { outcome: this.unknownTarget(), rule: 'tool.unknownKind', reason: request.title };
    }
  }

  /**
   * A request whose target we could not pin down is not refused outright: a
   * human reading the tool call title knows more than we do. With no escalator
   * installed this still ends in a denial.
   */
  private unknownTarget(): RuleOutcome {
    return 'ask';
  }
}

/**
 * Real adapters omit `kind` on permission requests — claude-code-acp sends the
 * file it wants to write and no kind at all. Refusing those would refuse most
 * honest work, so the request is read for what it evidently is: something that
 * names files is a file operation. A request that names a command never reaches
 * here; those are judged as commands before the kind is consulted at all.
 */
function infer(request: Extract<PolicyRequest, { kind: 'tool' }>): ToolKind | undefined {
  if (request.locations.length > 0) return 'edit';
  return undefined;
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

/** Best-effort extraction of a command from an agent's own tool input. */
export function commandFromRawInput(raw: unknown): { command: string; args: string[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const argv = input['argv'] ?? input['args'];
  if (typeof input['command'] === 'string' && Array.isArray(argv)) {
    return { command: input['command'], args: argv.filter((a): a is string => typeof a === 'string') };
  }
  // codex puts the whole argv in `command` as an array — `["/bin/zsh","-lc","ls"]`.
  // That is a command stated plainly enough to check, and reading it as one is
  // the difference between the allowlist judging it and `tool.opaqueCommand`
  // refusing every command codex ever asks for.
  if (Array.isArray(input['command'])) {
    const argv = input['command'].filter((a): a is string => typeof a === 'string');
    if (argv.length === 0 || argv.length !== input['command'].length) return undefined;
    return { command: argv[0]!, args: argv.slice(1) };
  }
  const script = ['command', 'cmd', 'script', 'shell_command'].find(
    (key) => typeof input[key] === 'string',
  );
  if (!script) return undefined;
  const scan = scanScript(input[script] as string);
  if (!scan.ok || scan.tokens.length === 0) return undefined;
  // Hand the operator back through the shell path so exec policy judges it.
  if (scan.operator) return { command: 'sh', args: ['-c', input[script] as string] };
  return { command: scan.tokens[0]!, args: scan.tokens.slice(1) };
}

/**
 * The command a shell tool call's title states, for an adapter that states it
 * nowhere else. gemini-cli's shell tool titles itself with the command when it
 * is 150 characters or under, or has no description; older builds added an
 * ` [in <dir>]` suffix, which is cut. A title that does not read as a command
 * — a description, an unbalanced quote — is not one, and is left to a person.
 */
export function commandFromTitle(title: string): { command: string; args: string[] } | undefined {
  const text = title.replace(/\s\[in [^\]]+\]$/, '').trim();
  if (text === '') return undefined;
  const scan = scanScript(text);
  if (!scan.ok || scan.tokens.length === 0) return undefined;
  if (scan.operator) return { command: 'sh', args: ['-c', text] };
  return { command: scan.tokens[0]!, args: scan.tokens.slice(1) };
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
