import path from 'node:path';
import type { ToolKind } from '@agentclientprotocol/sdk';
import type { Policy, RuleOutcome } from '../config/schema.js';
import { Jail } from './jail.js';
import { checkExec, render, scanScript } from './exec.js';
import type { AuditEntry, Decision, Escalator, PolicyRequest } from './types.js';

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

/**
 * One place where every side effect an agent asks for is judged, whichever of
 * the three gates it arrived through. Rules run first and are deterministic;
 * anything they cannot settle is escalated, and an escalation nobody answers is
 * a denial. There is no path through this class that ends in an unrecorded yes.
 */
export class PolicyEngine {
  private readonly policy: Policy;
  private readonly jail: Jail;
  private escalator: Escalator | undefined;
  private readonly onDecision: ((entry: AuditEntry) => void) | undefined;
  private readonly now: () => number;

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

  async resolve(request: PolicyRequest): Promise<Decision> {
    const summary = describe(request, this.jail);
    const ruling = this.rule(request);

    let decision: Decision;
    if (ruling.outcome === 'allow') {
      decision = { verdict: 'allow', rule: ruling.rule, reason: ruling.reason };
    } else if (ruling.outcome === 'deny') {
      decision = { verdict: 'deny', rule: ruling.rule, reason: ruling.reason };
    } else {
      decision = await this.escalate(request, ruling, summary);
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
  ): Promise<Decision> {
    const escalator = this.policy.escalation.includes('user') ? this.escalator : undefined;
    if (!escalator) {
      return {
        verdict: 'deny',
        rule: ruling.rule,
        reason: `${ruling.reason ?? 'needs a decision'} (nobody available to approve)`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.policy.decisionTimeoutMs);
    try {
      // The deadline is enforced here rather than inside the escalator. An
      // escalator that ignores the signal — a wedged UI, a bad implementation —
      // must not be able to hold a permission request open indefinitely.
      const allowed = await Promise.race([
        escalator.ask({
          summary,
          detail: ruling.reason ?? '',
          rule: ruling.rule,
          context: { agentId: request.agentId, sessionId: request.sessionId },
          signal: controller.signal,
        }),
        aborted(controller.signal).then((): boolean => {
          throw new Error('timed out');
        }),
      ]);
      return {
        verdict: allowed ? 'allow' : 'deny',
        rule: ruling.rule,
        reason: allowed ? undefined : 'declined',
        escalated: true,
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
      clearTimeout(timer);
    }
  }

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
        shellOperators: this.policy.exec.shellOperators,
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
        const command = commandFromRawInput(request.rawInput);
        if (!command) {
          // Some agents describe a command only in the title and keep the real
          // invocation to themselves — gemini does. Approving that would be
          // approving whatever its own shell decides to run, which is the one
          // thing the allowlist exists to prevent. There is no safe yes here.
          return {
            outcome: 'deny',
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
