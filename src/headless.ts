import readline from 'node:readline';
import type { AgentName, Config } from './config/schema.js';
import type { TaskStatus } from './agents/types.js';
import { Orchestrator } from './orchestrator/orchestrator.js';

export type OutputFormat = 'text' | 'json';

export type HeadlessEvent =
  | { type: 'workspace'; runDir: string }
  | { type: 'assistant'; text: string }
  | { type: 'task_started'; id: number; agent: AgentName; task: string }
  | { type: 'task_finished'; id: number; agent: AgentName; status: TaskStatus; summary: string }
  | { type: 'error'; message: string }
  | { type: 'turn_done' };

const escapeNewlines = (text: string) => text.replace(/\n/g, '\\n');

/**
 * `text` is the human-readable line protocol; `json` is JSONL, one event object per
 * line, for scripting. Only the text form abbreviates — a script wants the whole
 * task and summary, not a display-width slice of them.
 */
export function formatEvent(event: HeadlessEvent, format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(event);
  switch (event.type) {
    case 'workspace':
      return `[workspace] ${event.runDir}`;
    case 'assistant':
      return `[assistant] ${escapeNewlines(event.text)}`;
    case 'task_started':
      return `[task ${event.agent} #${event.id}] started ${event.task.replace(/\n/g, ' ').slice(0, 200)}`;
    case 'task_finished':
      return `[task ${event.agent} #${event.id}] finished: ${event.status}`;
    case 'error':
      return `[error] ${escapeNewlines(event.message)}`;
    case 'turn_done':
      return '[done]';
  }
}

/**
 * Plain line-oriented stdio mode. Same config loader, orchestrator, adapters
 * and real CLIs as the TUI — only the render layer differs. This is both the
 * primary e2e surface and a scriptable one-shot mode.
 */
export async function runHeadless(
  config: Config,
  oneShotPrompt?: string,
  format: OutputFormat = 'text',
): Promise<void> {
  const orchestrator = new Orchestrator(config);
  const emit = (event: HeadlessEvent) => process.stdout.write(formatEvent(event, format) + '\n');

  orchestrator.on('assistant_text', (text) => emit({ type: 'assistant', text }));
  orchestrator.on('task_started', ({ id, agent, task }) =>
    emit({ type: 'task_started', id, agent, task }),
  );
  orchestrator.on('task_finished', ({ id, agent, status, summary }) =>
    emit({ type: 'task_finished', id, agent, status, summary }),
  );
  orchestrator.on('error', (message) => emit({ type: 'error', message }));
  orchestrator.on('turn_done', () => emit({ type: 'turn_done' }));

  emit({ type: 'workspace', runDir: orchestrator.session.runDir });

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
