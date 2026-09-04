import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeSources, loadConfig } from './config/load.js';
import { doctor } from './commands/doctor.js';
import { run } from './commands/run.js';
import { debug, debugTargetFromEnv, describeProxyEnv, enableDebug, fileSink } from './debug.js';
import { VERSION } from './version.js';

const USAGE = `handsfree — an ACP host for frontier coding agents

  handsfree                     start the terminal UI
  handsfree run "<prompt>"      one turn, no UI (asks on stderr at a terminal,
                                denies every escalation when piped or in CI)
  handsfree doctor              handshake with each configured agent
  handsfree serve --acp         speak ACP on stdio, for an editor to drive

The directory you start in is the workspace, and the workspace is the boundary
the agents work inside: this checkout, not your whole disk.

Options
  --sandbox                     work in an empty scratch workspace instead of this directory
  --json                        with run: emit the transcript as NDJSON
  --run <id>                    reuse an existing run directory
  --debug                       diagnostics on stderr: launches, environment, handshakes
                                (also HANDSFREE_DEBUG=1, or =<path> to append to a file;
                                the TUI logs to a file, since stderr would be drawn over)
  -h, --help                    this text
  -v, --version                 print the version
`;

interface Args {
  command: 'tui' | 'run' | 'doctor' | 'serve' | 'help' | 'version';
  prompt: string;
  json: boolean;
  debug: boolean;
  /** Work in a fresh empty workspace rather than the directory we were started in. */
  sandbox: boolean;
  runId: string | undefined;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'tui',
    prompt: '',
    json: false,
    debug: false,
    sandbox: false,
    runId: undefined,
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') args.json = true;
    else if (arg === '--sandbox') args.sandbox = true;
    else if (arg === '--debug') args.debug = true;
    else if (arg === '--acp') args.command = 'serve';
    else if (arg === '--run') args.runId = argv[++i];
    else if (arg === '-h' || arg === '--help') args.command = 'help';
    else if (arg === '-v' || arg === '--version') args.command = 'version';
    else rest.push(arg);
  }

  if (rest[0] === 'serve') args.command = 'serve';
  if (args.command === 'serve') return args;

  if (args.command === 'tui' && rest.length > 0) {
    const [first, ...tail] = rest;
    if (first === 'run') {
      args.command = 'run';
      args.prompt = tail.join(' ');
    } else if (first === 'doctor') {
      args.command = 'doctor';
    } else {
      // Bare text is a prompt: `handsfree "fix the tests"` should just work.
      args.command = 'run';
      args.prompt = rest.join(' ');
    }
  }
  return args;
}

/**
 * The workspace is the jail, so attaching to a directory hands the agents
 * everything under it. A home directory or a filesystem root is not a project —
 * it is every project, plus keys, mail and browser profiles — and landing in one
 * is far more often a wrong turn than an intention. Refusing is cheap; the two
 * ways forward are named in the same breath.
 */
export function tooBroadToAttach(dir: string, home: string = os.homedir()): string | undefined {
  const target = path.resolve(dir);
  const what =
    target === path.parse(target).root
      ? 'the filesystem root'
      : target === path.resolve(home)
        ? 'your home directory'
        : undefined;
  if (!what) return undefined;
  return (
    `handsfree will not make ${what} a workspace: the workspace is the boundary ` +
    'agents work inside, and that one holds everything.\n' +
    'cd into a project, or pass --sandbox to work in an empty scratch workspace.'
  );
}

/**
 * Where debug lines land. stderr, except in the TUI, where ink owns the whole
 * terminal and interleaved writes would be drawn over — there they go to a
 * file, whose path is printed once before the UI takes the screen.
 */
function setUpDebug(args: Args): void {
  const fromEnv = debugTargetFromEnv(process.env['HANDSFREE_DEBUG']);
  const target = args.debug && fromEnv === 'off' ? 'stderr' : fromEnv;
  if (target === 'off') return;

  if (typeof target === 'object') {
    enableDebug(fileSink(target.file), target.file);
    if (args.command === 'tui') process.stderr.write(`debug log: ${target.file}\n`);
  } else if (args.command === 'tui') {
    const file = `handsfree-debug-${process.pid}.log`;
    enableDebug(fileSink(file), file);
    process.stderr.write(`debug log: ${file}\n`);
  } else {
    enableDebug();
  }

  debug('start', `handsfree ${VERSION}, node ${process.version} on ${process.platform}`);
  debug('start', `argv: ${process.argv.slice(2).join(' ') || '(none)'}`);
  debug('env', describeProxyEnv(process.env));
  debug(
    'env',
    'agents are spawned directly, not through a shell: aliases and functions from ' +
      'your rc files (e.g. `alias claude="HTTP_PROXY= claude"`) do not apply to them — ' +
      'they inherit this process environment, shaped by the config\'s top-level `env` block ' +
      'and the profile\'s `env`.',
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write(`handsfree ${VERSION}\n`);
    return 0;
  }

  setUpDebug(args);

  const { config, sources } = loadConfig();
  debug(
    'config',
    sources.length > 0
      ? `loaded from ${describeSources(sources)}`
      : 'no config file found, using defaults',
  );
  const orchestration = config.orchestration;
  debug(
    'config',
    orchestration.provider === 'acp'
      ? `orchestration: agent "${orchestration.acp.agent}" over ACP`
      : `orchestration: ${orchestration.local.model} at ${orchestration.local.baseURL}`,
  );

  if (args.command === 'serve') {
    // stdout belongs to the protocol from here on: nothing else may write to it.
    const { serve } = await import('./commands/serve.js');
    return serve(config, sources);
  }

  // Work happens where you started, because coding in a directory with no code
  // in it is not the common case. `--sandbox` is the old empty workspace, for a
  // turn that has no project.
  let attachTo: string | undefined;
  if (!args.sandbox) {
    attachTo = process.cwd();
    const refusal = tooBroadToAttach(attachTo);
    if (refusal) {
      // `doctor` starts no agent and touches nothing, and it is the command you
      // reach for when you are checking an install from wherever you happen to
      // be standing. It reports the sandbox instead of refusing to run.
      if (args.command !== 'doctor') {
        process.stderr.write(`${refusal}\n`);
        return 2;
      }
      attachTo = undefined;
    }
    if (attachTo) debug('workspace', `attached to ${attachTo}`);
  }

  const write = (line: string) => process.stdout.write(`${line}\n`);

  if (args.command === 'doctor') {
    if (sources.length > 0) write(`config: ${describeSources(sources)}`);
    const reports = await doctor(config, write, {
      ...(attachTo === undefined ? {} : { attachTo }),
    });
    return reports.every((report) => report.ok) ? 0 : 1;
  }

  if (args.command === 'run') {
    if (args.prompt.trim() === '') {
      process.stderr.write('handsfree run needs a prompt.\n');
      return 2;
    }
    return run(
      config,
      args.prompt,
      {
        json: args.json,
        ...(args.runId === undefined ? {} : { runId: args.runId }),
        ...(attachTo === undefined ? {} : { attachTo }),
        configSources: sources,
      },
      write,
    );
  }

  // The terminal UI pulls in ink and react, so it is loaded only when used.
  const { tui } = await import('./commands/tui.js');
  return tui(config, {
    ...(args.runId === undefined ? {} : { runId: args.runId }),
    ...(attachTo === undefined ? {} : { attachTo }),
    configSources: sources,
  });
}

// Only when this file *is* the command. Importing it — a test reaching for the
// argument parser — must not start a session on whatever argv happens to hold.
// The comparison is made on real paths: an installed `handsfree` is a symlink in
// a `.bin` directory, and node resolves the module through it but leaves argv
// spelling it the short way.
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    });
}
