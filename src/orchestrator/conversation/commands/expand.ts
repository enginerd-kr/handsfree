import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildEnv } from '../../../host/capabilities/terminal.js';
import { render, scanScript } from '../../../policy/exec.js';
import { substituteArguments } from './arguments.js';
import type { CommandBase, CommandHost, PromptCommand } from './command.js';

/** How many of each kind of reference one command file may carry. */
const MAX_SHELL_REFS = 10;
const MAX_FILE_REFS = 20;

/** A fenced `` ```! `` block, and the inline `` !`cmd` `` beside it. */
const BLOCK = /```!\s*\n([\s\S]*?)\n?```/g;
const INLINE = /(\\?)!`([^`\n]+)`/g;
/** A file reference: `@path`, at the start of a line or after a space. */
const FILE = /(^|\s)(\\?)@([^\s`]+)/g;

/**
 * The body of a command file, turned into the message the model is given.
 *
 * Three passes, in this order: the arguments go in first so that `@$1` and
 * `` !`git log $1` `` mean what they look like; then the shell references; then
 * the file references. That an argument can therefore reach a shell is not a
 * bypass, because what comes out the other side still requires approval — the
 * boundary here is the policy engine, never the order of substitution.
 *
 * Nothing in here decides whether a command may run or a file may be read. It
 * asks, and it writes down what it was told, refusals included: a command whose
 * evidence was refused still goes to the model, saying plainly that it was
 * refused, because working around a refusal is exactly what agents are told not
 * to do.
 */
export async function expandBody(
  command: CommandBase & PromptCommand,
  args: string,
  host: CommandHost,
  signal?: AbortSignal,
): Promise<string> {
  let body = substituteArguments(command.body, args, command.argNames);
  body = await expandShell(body, host, signal);
  body = await expandFiles(body, host);
  return body;
}

async function expandShell(body: string, host: CommandHost, signal?: AbortSignal): Promise<string> {
  let used = 0;
  const replace = async (pattern: RegExp, text: string, group: number): Promise<string> => {
    const matches = [...text.matchAll(pattern)];
    let out = '';
    let at = 0;
    for (const match of matches) {
      out += text.slice(at, match.index);
      at = match.index + match[0].length;
      // A backslash in front is how a command file writes the syntax itself.
      if (group === 2 && match[1] === '\\') {
        out += match[0].slice(1);
        continue;
      }
      const script = (match[group] ?? '').trim();
      if (used >= MAX_SHELL_REFS) {
        out += refusal(`run ${script}`, `more than ${MAX_SHELL_REFS} commands in one command file`);
        continue;
      }
      used++;
      out += signal?.aborted ? refusal(`run ${script}`, 'stopped') : await shell(script, host, signal);
    }
    return out + text.slice(at);
  };

  return replace(INLINE, await replace(BLOCK, body, 1), 2);
}

async function shell(script: string, host: CommandHost, signal?: AbortSignal): Promise<string> {
  // A script with nothing in it a shell would interpret is run as the argv it
  // already is. Shell syntax is passed intact to sh -c after approval.
  const scan = scanScript(script);
  const argv =
    scan.ok && !scan.operator && scan.tokens.length > 0 ? scan.tokens : ['sh', '-c', script];

  const decision = await host.policy.resolve({
    kind: 'exec',
    agentId: host.agentId,
    sessionId: host.workspace.id,
    command: argv[0]!,
    args: argv.slice(1),
    cwd: host.workspace.dir,
  });
  if (decision.verdict === 'deny') return refusal(`run ${render(argv)}`, decision.reason);

  return runOnce(argv, host, signal);
}

/**
 * One command, run to completion. Not `TerminalRegistry`: that exists to keep a
 * terminal addressable by id across `output`, `wait_for_exit`, `kill` and
 * `release`, none of which a one-shot expansion has any use for. What it does
 * borrow is everything that decides how the command is contained — the
 * environment and process group — because a
 * command handsfree runs on its own behalf is not a privileged one.
 *
 * It also answers the escape key. Expansion happens before the turn it belongs
 * to has anything else to show, so a command with nothing to say for a minute
 * would otherwise be a minute nobody could interrupt.
 */
async function runOnce(
  argv: readonly string[],
  host: CommandHost,
  signal?: AbortSignal,
): Promise<string> {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: host.workspace.dir,
    env: buildEnv([]),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so cancellation reaches the whole tree rather
    // than leaving orphans behind holding the workspace open.
    detached: true,
  });

  const chunks: Buffer[] = [];
  const collect = (chunk: Buffer) => { chunks.push(chunk); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const kill = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };

  let stop: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('close', done);
      child.once('error', done);
      stop = () => {
        kill();
        done();
      };
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });
  } finally {
    if (stop) signal?.removeEventListener('abort', stop);
  }

  return Buffer.concat(chunks).toString('utf8').trimEnd();
}

async function expandFiles(body: string, host: CommandHost): Promise<string> {
  const matches = [...body.matchAll(FILE)];
  let out = '';
  let at = 0;
  let used = 0;

  for (const match of matches) {
    out += body.slice(at, match.index);
    at = match.index + match[0].length;
    const [, lead = '', escape = '', reference = ''] = match;
    if (escape === '\\') {
      out += `${lead}@${reference}`;
      continue;
    }

    // A reference is only a reference when it names a file that is there. An
    // `@types/node`, an address in a sentence, a `@media` rule: all of them
    // would otherwise become a read attempt, and a refusal for something
    // nobody asked to read is worse than leaving the text alone.
    const target = path.resolve(host.workspace.dir, reference);
    const jailed = host.jail.check(target);
    if (!jailed.ok || !isFile(jailed.real)) {
      out += match[0];
      continue;
    }

    if (used >= MAX_FILE_REFS) {
      out += `${lead}${refusal(`read ${reference}`, `more than ${MAX_FILE_REFS} files in one command file`)}`;
      continue;
    }
    used++;

    const decision = await host.policy.resolve({
      kind: 'fs.read',
      agentId: host.agentId,
      sessionId: host.workspace.id,
      path: jailed.real,
    });
    if (decision.verdict === 'deny') {
      out += `${lead}${refusal(`read ${reference}`, decision.reason)}`;
      continue;
    }

    try {
      const content = fs.readFileSync(jailed.real, 'utf8');
      out += `${lead}\n\`\`\`${host.jail.display(jailed.real)}\n${content.trimEnd()}\n\`\`\`\n`;
    } catch (err) {
      out += `${lead}${refusal(`read ${reference}`, (err as Error).message)}`;
    }
  }

  return out + body.slice(at);
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** What stands in for a reference that was not allowed. Said, never hidden. */
function refusal(what: string, why: string | undefined): string {
  return `[handsfree refused to ${what}${why ? ` — ${why}` : ''}]`;
}
