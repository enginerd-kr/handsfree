import { execa } from 'execa';
import type { AgentName, Config } from './config/schema.js';

export async function runDoctor(config: Config): Promise<boolean> {
  let ok = true;
  const report = (good: boolean, label: string, detail: string) => {
    if (!good) ok = false;
    process.stdout.write(`${good ? 'ok  ' : 'FAIL'}  ${label}: ${detail}\n`);
  };

  try {
    const res = await fetch(new URL('models', config.llm.baseURL + '/').toString(), {
      signal: AbortSignal.timeout(5000),
    });
    report(res.ok, 'llm endpoint', `${config.llm.baseURL} (HTTP ${res.status}), model=${config.llm.model}`);
  } catch (err) {
    report(
      false,
      'llm endpoint',
      `${config.llm.baseURL} unreachable (${(err as Error).message}). Start LM Studio/Ollama or set HANDSFREE_LLM_BASE_URL.`,
    );
  }

  for (const name of Object.keys(config.agents) as AgentName[]) {
    const agent = config.agents[name];
    if (!agent.enabled) {
      report(true, name, 'disabled');
      continue;
    }
    try {
      const res = await execa(agent.command, ['--version'], { timeout: 15_000, reject: false });
      report(res.exitCode === 0, name, res.exitCode === 0 ? String(res.stdout).trim().split('\n')[0] : `exit ${res.exitCode}`);
    } catch (err) {
      report(false, name, `not runnable: ${(err as Error).message}`);
    }
  }
  return ok;
}
