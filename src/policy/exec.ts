import path from 'node:path';

export interface ExecRequest {
  command: string;
  args: string[];
}

export type ExecCheck =
  | { outcome: 'allow'; rule: string; argv: string[] }
  | { outcome: 'ask'; rule: string; argv: string[]; reason: string }
  | { outcome: 'deny'; rule: string; reason: string };

export interface ExecPolicy {
  mode: 'allowlist' | 'ask' | 'deny';
  allow: string[];
  /** What becomes of a command the allowlist does not name. */
  otherwise: 'allow' | 'ask' | 'deny';
  shellOperators: 'allow' | 'ask' | 'deny';
  /**
   * Whether `cd <dir>` at the head of a chain may pass on its own: the
   * directory is inside the workspace, say. Absent, a `cd` is a command like
   * any other, and one no allowlist names.
   */
  allowCd?: (dir: string) => boolean;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/**
 * Commands that are never in scope for a delegated coding task, whatever the
 * allowlist says. This is not a security boundary — the allowlist is — but a
 * pattern that reaches here usually means the request was misunderstood.
 */
const NEVER: { pattern: RegExp; reason: string }[] = [
  { pattern: /^sudo$|^doas$|^su$/, reason: 'privilege escalation' },
  { pattern: /^mkfs/, reason: 'filesystem creation' },
  { pattern: /^shutdown$|^reboot$|^halt$/, reason: 'host power control' },
];

export function checkExec(request: ExecRequest, policy: ExecPolicy): ExecCheck {
  if (policy.mode === 'deny') {
    return { outcome: 'deny', rule: 'exec.mode=deny', reason: 'command execution is disabled' };
  }

  const flat = flatten(request);
  if (!flat.ok) return { outcome: 'deny', rule: flat.rule, reason: flat.reason };

  const argv = flat.argv;
  if (argv.length === 0) {
    return { outcome: 'deny', rule: 'exec.empty', reason: 'no command to run' };
  }
  for (const token of argv) {
    if (token.includes('\0')) {
      return { outcome: 'deny', rule: 'exec.nullByte', reason: 'argument contains a null byte' };
    }
  }

  // Before the script around it is judged, the command itself is: `sudo` at the
  // head of a pipeline is still `sudo`, and a refusal nobody can approve their
  // way past must not become a question just because a `|` came after it.
  const name = path.basename(argv[0]!);
  for (const { pattern, reason } of NEVER) {
    if (pattern.test(name)) {
      return { outcome: 'deny', rule: 'exec.never', reason };
    }
  }

  if (flat.operator) {
    // A chain of commands the allowlist names — `node --version && node
    // test.mjs`, `cd src && pnpm test` — is what an agent writes when it
    // means two allowed things in a row, and refusing it as "a shell
    // operator" refuses the allowlist's own entries. Each link is judged as
    // the command it is; the chain passes when every link does. Anything
    // that is not a plain chain — a redirect, a substitution — is still an
    // operator, and so is a chain with a link nobody allowed.
    if (flat.segments && policy.mode === 'allowlist') {
      const matched: string[] = [];
      let allowed = true;
      for (const segment of flat.segments) {
        const link = judgeLink(segment, policy);
        if (link.outcome === 'never') {
          return { outcome: 'deny', rule: 'exec.never', reason: link.reason };
        }
        if (link.outcome === 'allow') matched.push(link.rule);
        else allowed = false;
      }
      if (allowed) return { outcome: 'allow', rule: `exec.allow:chain(${matched.join('; ')})`, argv };
    }
    const reason = `shell operator ${flat.operator} in "${flat.script}"`;
    if (policy.shellOperators === 'deny') {
      return { outcome: 'deny', rule: 'exec.shellOperators', reason };
    }
    if (policy.shellOperators === 'ask') {
      return { outcome: 'ask', rule: 'exec.shellOperators', argv, reason };
    }
  }

  if (policy.mode === 'ask') {
    return { outcome: 'ask', rule: 'exec.mode=ask', argv, reason: render(argv) };
  }

  const matched = policy.allow.find((entry) => matches(entry, argv, name));
  if (matched) return { outcome: 'allow', rule: `exec.allow:${matched}`, argv };

  // Not on the list is a question, not a verdict — unless the settings say
  // otherwise, or there is nobody to ask, which the engine answers as a denial.
  const reason = `"${render(argv)}" is not on the command allowlist`;
  if (policy.otherwise === 'allow') return { outcome: 'allow', rule: 'exec.otherwise', argv };
  if (policy.otherwise === 'ask') return { outcome: 'ask', rule: 'exec.otherwise', argv, reason };
  return { outcome: 'deny', rule: 'exec.otherwise', reason };
}

type Link =
  | { outcome: 'allow'; rule: string }
  | { outcome: 'never'; reason: string }
  | { outcome: 'other' };

/** One command of a chain, judged the way it would be on its own. */
function judgeLink(argv: string[], policy: ExecPolicy): Link {
  if (argv.length === 0) return { outcome: 'other' };
  const name = path.basename(argv[0]!);
  for (const { pattern, reason } of NEVER) {
    if (pattern.test(name)) return { outcome: 'never', reason };
  }
  if (name === 'cd') {
    return argv.length === 2 && policy.allowCd?.(argv[1]!) ? { outcome: 'allow', rule: 'cd' } : { outcome: 'other' };
  }
  const matched = policy.allow.find((entry) => matches(entry, argv, name));
  if (matched) return { outcome: 'allow', rule: matched };
  if (policy.otherwise === 'allow') return { outcome: 'allow', rule: 'otherwise' };
  return { outcome: 'other' };
}

/** True when `entry`'s tokens are a prefix of `argv`, comparing argv[0] by basename. */
function matches(entry: string, argv: string[], name: string): boolean {
  const tokens = entry.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > argv.length) return false;
  if (path.basename(tokens[0]!) !== name) return false;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] !== argv[i]) return false;
  }
  return true;
}

export function render(argv: string[]): string {
  return argv.map((token) => (/\s/.test(token) ? JSON.stringify(token) : token)).join(' ');
}

type Flattened =
  | {
      ok: true;
      argv: string[];
      operator?: string;
      script?: string;
      /** The commands of a plain chain, in order, when the script is one. */
      segments?: string[][];
    }
  | { ok: false; rule: string; reason: string };

/**
 * ACP hands us a command and an argument array, so nothing is interpreted by a
 * shell unless the command *is* a shell. In that case the real request lives in
 * the script argument, and it has to be understood before it can be judged.
 */
function flatten(request: ExecRequest): Flattened {
  const argv = [request.command, ...request.args];
  const name = path.basename(request.command);
  if (!SHELLS.has(name)) return { ok: true, argv };

  const flagIndex = request.args.findIndex((arg) => arg === '-c' || arg === '-lc' || arg === '-ic');
  if (flagIndex === -1) {
    return { ok: false, rule: 'exec.interactiveShell', reason: 'an interactive shell has no task' };
  }
  const script = request.args[flagIndex + 1];
  if (script === undefined) {
    return { ok: false, rule: 'exec.shell', reason: `${name} -c with no script` };
  }

  const scan = scanScript(script);
  if (!scan.ok) return { ok: false, rule: 'exec.unparseable', reason: scan.reason };
  if (scan.operator) {
    const chain = scanChain(script);
    const segments = chain.ok && chain.segments.length > 1 ? chain.segments : undefined;
    return { ok: true, argv: scan.tokens, operator: scan.operator, script, ...(segments ? { segments } : {}) };
  }
  return { ok: true, argv: scan.tokens, script };
}

type Chain = { ok: true; segments: string[][] } | { ok: false; reason: string };

/**
 * A script read as a chain: commands joined by `&&`, `||`, `;` or `|`, and
 * nothing else — a redirect, a substitution, a backtick, a lone `&`, a
 * newline all make it not a chain, and the caller falls back to judging the
 * operator. Quoting is read the way scanScript reads it.
 */
export function scanChain(script: string): Chain {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  const endToken = () => {
    if (started) tokens.push(token);
    token = '';
    started = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length === 0) return false;
    segments.push(tokens);
    tokens = [];
    return true;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < script.length) {
        token += script[++i];
        continue;
      }
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && (ch === '$' || ch === '`')) return { ok: false, reason: 'substitution' };
      token += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < script.length) {
      token += script[++i];
      started = true;
      continue;
    }
    if (ch === '&' && script[i + 1] === '&') {
      if (!endSegment()) return { ok: false, reason: 'empty command' };
      i++;
      continue;
    }
    if (ch === '|') {
      if (!endSegment()) return { ok: false, reason: 'empty command' };
      if (script[i + 1] === '|') i++;
      continue;
    }
    if (ch === ';') {
      if (!endSegment()) return { ok: false, reason: 'empty command' };
      continue;
    }
    if (ch === '$' || ch === '`' || ch === '&' || ch === '<' || ch === '>' || ch === '\n') {
      return { ok: false, reason: `operator ${ch}` };
    }
    if (ch === ' ' || ch === '\t') {
      endToken();
      continue;
    }
    token += ch;
    started = true;
  }
  if (quote) return { ok: false, reason: 'unterminated quote' };
  if (!endSegment()) return { ok: false, reason: 'empty command' };
  return { ok: true, segments };
}

type Scan =
  | { ok: true; tokens: string[]; operator?: string }
  | { ok: false; reason: string };

/**
 * A deliberately small shell reader: it recognises quoting well enough to know
 * where a token ends, and treats everything that would hand control back to a
 * shell — pipes, substitution, redirection, chaining — as an operator to be
 * judged rather than something to emulate.
 */
export function scanScript(script: string): Scan {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;

    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < script.length) {
        token += script[++i];
        continue;
      }
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && (ch === '$' || ch === '`')) {
        return { ok: true, tokens, operator: ch === '$' ? '$(…)' : '`…`' };
      }
      token += ch;
      started = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < script.length) {
      token += script[++i];
      started = true;
      continue;
    }
    if (ch === '$' || ch === '`') {
      return { ok: true, tokens, operator: ch === '$' ? '$…' : '`…`' };
    }
    if (ch === '|' || ch === '&' || ch === ';' || ch === '<' || ch === '>' || ch === '\n') {
      return { ok: true, tokens, operator: ch === '\n' ? 'newline' : ch };
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    token += ch;
    started = true;
  }

  if (quote) return { ok: false, reason: 'unterminated quote' };
  if (started) tokens.push(token);
  return { ok: true, tokens };
}
