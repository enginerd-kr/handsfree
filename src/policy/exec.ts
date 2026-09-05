export function render(argv: string[]): string {
  return argv.map((token) => (/\s/.test(token) ? JSON.stringify(token) : token)).join(' ');
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
