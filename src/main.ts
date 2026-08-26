import { loadConfig } from './config/load.js';
import { doctor } from './commands/doctor.js';
import { run } from './commands/run.js';
import { VERSION } from './version.js';

const USAGE = `handsfree — an ACP host for frontier coding agents

  handsfree                     start the terminal UI
  handsfree run "<prompt>"      one turn, no UI (every escalation is denied)
  handsfree doctor              handshake with each configured agent
  handsfree serve --acp         speak ACP on stdio, for an editor to drive

Options
  --json                        with run: emit the transcript as NDJSON
  --run <id>                    reuse an existing run directory
  -h, --help                    this text
  -v, --version                 print the version
`;

interface Args {
  command: 'tui' | 'run' | 'doctor' | 'serve' | 'help' | 'version';
  prompt: string;
  json: boolean;
  runId: string | undefined;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'tui', prompt: '', json: false, runId: undefined };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') args.json = true;
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

  const { config, source } = loadConfig();

  if (args.command === 'serve') {
    // stdout belongs to the protocol from here on: nothing else may write to it.
    const { serve } = await import('./commands/serve.js');
    return serve(config);
  }

  const write = (line: string) => process.stdout.write(`${line}\n`);

  if (args.command === 'doctor') {
    if (source) write(`config: ${source}`);
    const reports = await doctor(config, write);
    return reports.every((report) => report.ok) ? 0 : 1;
  }

  if (args.command === 'run') {
    if (args.prompt.trim() === '') {
      process.stderr.write('handsfree run needs a prompt.\n');
      return 2;
    }
    return run(config, args.prompt, { json: args.json, runId: args.runId }, write);
  }

  // The terminal UI pulls in ink and react, so it is loaded only when used.
  const { tui } = await import('./commands/tui.js');
  return tui(config, args.runId);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
  });
