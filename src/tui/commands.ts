import type { Config } from '../config/schema.js';
import type { TaskRecord } from './useOrchestrator.js';
import { formatDuration, STATUS_ICON } from './format.js';

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show available commands and shortcuts' },
  { name: 'tasks', description: 'Show all tasks from this session' },
  { name: 'agents', description: 'Show configured agents and their scopes' },
  { name: 'status', description: 'Show session info (model, endpoint, run dir)' },
  { name: 'clear', description: 'Clear the conversation and start fresh' },
  { name: 'exit', aliases: ['quit'], description: 'Exit handsfree' },
];

/** Match "/par..." against command names and aliases. "/" alone lists everything. */
export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const query = input.slice(1).split(/\s/)[0].toLowerCase();
  return COMMANDS.filter(
    (c) => c.name.startsWith(query) || (c.aliases ?? []).some((a) => a.startsWith(query)),
  );
}

/** Resolve an exact command name or alias, e.g. "/quit" -> exit. */
export function resolveCommand(input: string): SlashCommand | undefined {
  const query = input.slice(1).split(/\s/)[0].toLowerCase();
  return COMMANDS.find((c) => c.name === query || (c.aliases ?? []).includes(query));
}

export function formatHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 1;
  const lines = COMMANDS.map((c) => {
    const aliases = c.aliases?.length ? ` (also /${c.aliases.join(', /')})` : '';
    return `  /${c.name.padEnd(width)} ${c.description}${aliases}`;
  });
  return [
    'Commands:',
    ...lines,
    '',
    'Shortcuts:',
    '  ↑/↓         recall previous messages · navigate the command menu',
    '  Tab         complete the selected command',
    '  Enter       run the selected command, or send the message',
    '  Esc         cancel the running turn · clear the input',
    '',
    'Typing during a running turn is fine — messages queue and run in order.',
  ].join('\n');
}

export function formatTasks(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return 'No tasks yet this session.';
  const lines = tasks.map((t) => {
    const elapsed = formatDuration((t.endedAt ?? Date.now()) - t.startedAt);
    const status = t.status === 'running' ? `running · ${elapsed}` : `${t.status} · ${elapsed}`;
    return `  ${STATUS_ICON[t.status]} #${t.id} ${t.agent.padEnd(6)} ${status}\n      ${t.task}`;
  });
  const done = tasks.filter((t) => t.status !== 'running').length;
  return [`Tasks (${done}/${tasks.length} finished):`, ...lines].join('\n');
}

export function formatAgents(config: Config): string {
  const rows: string[] = [];
  const { claude, gemini, codex } = config.agents;
  rows.push(agentRow('claude', claude.enabled, `${claude.permissionMode} · tools: ${claude.allowedTools.join(', ')}`));
  rows.push(agentRow('gemini', gemini.enabled, `approval: ${gemini.approvalMode} · model: ${gemini.model}`));
  rows.push(agentRow('codex', codex.enabled, `sandbox: ${codex.sandbox}`));
  return ['Agents:', ...rows].join('\n');
}

function agentRow(name: string, enabled: boolean, scope: string): string {
  return `  ${enabled ? '●' : '○'} ${name.padEnd(7)} ${enabled ? scope : 'disabled'}`;
}

export function formatStatus(config: Config, runDir: string, tasks: TaskRecord[]): string {
  const done = tasks.filter((t) => t.status === 'success').length;
  const failed = tasks.filter((t) => t.status !== 'running' && t.status !== 'success').length;
  const running = tasks.length - done - failed;
  return [
    'Status:',
    `  model     ${config.llm.model}`,
    `  endpoint  ${config.llm.baseURL}`,
    `  run dir   ${runDir}`,
    `  tasks     ${done} ok · ${failed} failed · ${running} running`,
  ].join('\n');
}
