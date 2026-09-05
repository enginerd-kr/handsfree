export function render(argv: string[]): string {
  return argv.map((token) => (/\s/.test(token) ? JSON.stringify(token) : token)).join(' ');
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
 * shell — pipes, substitution, redirection, chaining — as a reason to pass
 * the complete script to the shell.
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
