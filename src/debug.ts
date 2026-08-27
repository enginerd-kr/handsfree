import { appendFileSync } from 'node:fs';

/**
 * Diagnostics for the cases the transcript cannot explain: an adapter that
 * dies before it speaks ACP, a handshake that never answers, a corporate proxy
 * standing between an agent and its API. Off unless asked for — `--debug` or a
 * non-empty HANDSFREE_DEBUG — and never on stdout, which may belong to the
 * protocol (`serve`) or the TUI.
 */

let sink: ((line: string) => void) | undefined;

export function debugEnabled(): boolean {
  return sink !== undefined;
}

/** Turns debug output on. Without a sink, lines go to stderr. */
export function enableDebug(write?: (line: string) => void): void {
  sink = write ?? ((line) => process.stderr.write(`${line}\n`));
}

/** Mainly for tests: puts the module back in its default, silent state. */
export function disableDebug(): void {
  sink = undefined;
}

export function debug(area: string, message: string): void {
  if (!sink) return;
  const time = new Date().toISOString().slice(11, 23);
  sink(`[debug ${time}] ${area}: ${message}`);
}

/**
 * Appends to a file instead of stderr, for the TUI — where stderr would be
 * drawn over — and for `HANDSFREE_DEBUG=<path>`. A failing debug sink must
 * never take the host down, so write errors are swallowed.
 */
export function fileSink(path: string): (line: string) => void {
  return (line) => {
    try {
      appendFileSync(path, `${line}\n`);
    } catch {
      // Debugging is best-effort by definition.
    }
  };
}

/**
 * Reads HANDSFREE_DEBUG: unset, empty, `0` and `false` leave debug off; a
 * value that looks like a path names the log file; anything else means stderr.
 */
export function debugTargetFromEnv(value: string | undefined): 'off' | 'stderr' | { file: string } {
  if (value === undefined || value === '' || value === '0' || /^false$/i.test(value)) return 'off';
  if (value.includes('/') || value.includes('\\') || /\.(log|txt)$/i.test(value)) {
    return { file: value };
  }
  return 'stderr';
}

const PROXY_VARS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

/**
 * One line saying exactly what proxy configuration a process sees. The
 * distinctions this spells out are the ones that cost people afternoons:
 * `HTTP_PROXY=` in a shell sets the variable to an *empty string* rather than
 * unsetting it — some tools treat that as "no proxy", others as "a proxy named
 * nothing" — and clearing `HTTP_PROXY` alone leaves `HTTPS_PROXY` standing,
 * which is the one API traffic actually uses.
 */
export function describeProxyEnv(env: Record<string, string | undefined>): string {
  const present: string[] = [];
  const unset: string[] = [];
  for (const name of PROXY_VARS) {
    const value = env[name];
    if (value === undefined) unset.push(name);
    else if (value === '') present.push(`${name}=<empty>`);
    else present.push(`${name}=${maskProxyUrl(value)}`);
  }
  const head = present.length > 0 ? present.join(' ') : 'no proxy variables set';
  return unset.length === PROXY_VARS.length ? head : `${head} (unset: ${unset.join(', ') || 'none'})`;
}

/** Proxy URLs routinely carry credentials; the host may be shown, the password may not. */
export function maskProxyUrl(value: string): string {
  return value.replace(/\/\/([^/@]*?):([^/@]*)@/g, (_match, user: string) => `//${user}:***@`);
}
