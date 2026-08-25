import readline from 'node:readline';
import type { Config } from './config/schema.js';
import { Orchestrator } from './orchestrator/orchestrator.js';

/**
 * Plain line-oriented stdio mode. Same config loader, orchestrator, adapters
 * and real CLIs as the TUI — only the render layer differs. This is both the
 * primary e2e surface and a scriptable one-shot mode.
 *
 * Output protocol (one event per line):
 *   [task <agent> #<id>] started ...
 *   [task <agent> #<id>] finished: <status>
 *   [assistant] <message, newlines escaped>
 *   [error] <message>
 *   [done]
 */
export async function runHeadless(config: Config, oneShotPrompt?: string): Promise<void> {
  const orchestrator = new Orchestrator(config);
  const out = (line: string) => process.stdout.write(line + '\n');

  orchestrator.on('assistant_text', (text) => out(`[assistant] ${text.replace(/\n/g, '\\n')}`));
  orchestrator.on('task_started', ({ id, agent, task }) =>
    out(`[task ${agent} #${id}] started ${task.replace(/\n/g, ' ').slice(0, 200)}`),
  );
  orchestrator.on('task_finished', ({ id, agent, status }) =>
    out(`[task ${agent} #${id}] finished: ${status}`),
  );
  orchestrator.on('error', (message) => out(`[error] ${message.replace(/\n/g, '\\n')}`));
  orchestrator.on('turn_done', () => out('[done]'));

  out(`[workspace] ${orchestrator.session.runDir}`);

  if (oneShotPrompt !== undefined) {
    await orchestrator.handleUserMessage(oneShotPrompt);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const queue: string[] = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length > 0) {
      const line = queue.shift()!;
      await orchestrator.handleUserMessage(line);
    }
    busy = false;
  };
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    queue.push(line);
    void pump();
  });
  await new Promise<void>((resolve) => rl.on('close', () => resolve()));
  // Drain anything still queued before exiting.
  while (busy || queue.length > 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
