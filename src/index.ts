import { parseArgs } from 'node:util';
import { loadConfig } from './config/load.js';

const { values, positionals } = parseArgs({
  options: {
    headless: { type: 'boolean', default: false },
    prompt: { type: 'string', short: 'p' },
    workspace: { type: 'string' },
    config: { type: 'string' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  process.stdout.write(`handsfree — local small-LLM orchestrator over frontier CLIs

Usage:
  handsfree                       interactive chat TUI
  handsfree --headless            line-mode stdio (one user message per line)
  handsfree --headless -p "..."   one-shot message, print result, exit
  handsfree doctor                preflight: LLM endpoint + agent CLIs

Options:
  --workspace <dir>   workspace root (default ~/.handsfree/workspaces)
  --config <file>     config file (default ./handsfree.config.json)
  --base-url <url>    OpenAI-compatible endpoint (default http://localhost:1234/v1)
  --model <name>      orchestrator model id
  -p, --prompt <msg>  one-shot message (implies --headless)
`);
  process.exit(0);
}

const config = loadConfig({
  baseURL: values['base-url'],
  model: values.model,
  workspaceRoot: values.workspace,
  configFile: values.config,
});

if (positionals[0] === 'doctor') {
  const { runDoctor } = await import('./doctor.js');
  const ok = await runDoctor(config);
  process.exit(ok ? 0 : 1);
} else if (values.headless || values.prompt !== undefined) {
  const { runHeadless } = await import('./headless.js');
  await runHeadless(config, values.prompt);
} else {
  const { startTui } = await import('./tui/start.js');
  await startTui(config);
}
