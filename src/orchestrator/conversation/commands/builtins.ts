import os from 'node:os';
import { agentRole, orchestrationModel } from '../../../config/schema.js';
import { spendOf } from '../../usage/usage.js';
import type { PermissionMode } from '../../../policy/mode.js';
import { commandSearchPaths } from './files.js';
import type { Command, CommandHost } from './command.js';

/**
 * The commands handsfree answers itself.
 *
 * They win over anything read from disk. A command file is often someone
 * else's — it arrives with a repository — and `/exit` meaning something other
 * than leaving is not a thing a checkout should be able to arrange.
 */
export function builtins(): Command[] {
  return [
    {
      kind: 'local',
      name: 'help',
      description: 'what you can type, and where the rest of it comes from',
      source: 'builtin',
      run: (_args, host) => ({ do: 'say', text: 'commands', lines: help(host) }),
    },
    {
      kind: 'local',
      name: 'clear',
      description: 'forget the conversation and clear the screen',
      source: 'builtin',
      run: () => ({ do: 'clear' }),
    },
    {
      kind: 'local',
      name: 'exit',
      aliases: ['quit'],
      description: 'leave',
      source: 'builtin',
      interactive: true,
      run: () => ({ do: 'quit' }),
    },
    {
      kind: 'local',
      name: 'agents',
      description: 'the agents this run can delegate to',
      source: 'builtin',
      run: (_args, host) => ({ do: 'say', text: 'agents', lines: agents(host) }),
    },
    {
      kind: 'local',
      name: 'config',
      description: 'what handsfree is running with, and where it read it',
      source: 'builtin',
      run: (_args, host) => ({ do: 'say', text: 'configuration', lines: configuration(host) }),
    },
    {
      kind: 'local',
      name: 'cost',
      description: 'what this run has spent, in tokens, on planning and on each agent',
      source: 'builtin',
      run: (_args, host) => ({ do: 'say', text: 'cost', lines: cost(host) }),
    },
  ];
}

/**
 * The run's spend, added up from the record. The planner's characters are
 * always there; tokens only where the endpoint counted them. Each agent
 * follows with what its turns took, as its CLI counted them, and how full its
 * context is where it says. The last lines are the ones the report contract
 * is judged by: of everything the agents said, how much the planner was made
 * to read.
 */
function cost(host: CommandHost): string[] {
  const usage = host.transcript
    .all()
    .filter((record): record is Extract<typeof record, { type: 'usage' }> => record.type === 'usage');
  const plans = usage.filter((record) => record.purpose !== 'task');
  const tasks = usage.filter((record) => record.purpose === 'task');
  const sum = (records: typeof usage, pick: (record: (typeof usage)[number]) => number | undefined) =>
    records.reduce((total, record) => total + (pick(record) ?? 0), 0);
  const counted = plans.filter((record) => record.promptTokens !== undefined);

  const lines = [
    `planner: ${plans.length} call${plans.length === 1 ? '' : 's'}, ` +
      `${figure(sum(plans, (r) => r.promptChars))} chars in (≈${figure(estimateTokens(sum(plans, (r) => r.promptChars)))} tokens), ` +
      `${figure(sum(plans, (r) => r.replyChars))} out`,
  ];
  if (counted.length > 0) {
    lines.push(
      `         endpoint counted ${figure(sum(counted, (r) => r.promptTokens))} in + ` +
        `${figure(sum(counted, (r) => r.completionTokens))} out tokens over ${counted.length} of them`,
    );
  }
  const spend = spendOf(host.transcript.all());
  const width = Math.max(...Object.keys(spend.agents).map((id) => id.length), 'planner'.length) + 1;
  for (const [agentId, agent] of Object.entries(spend.agents)) {
    const head = `${agentId}:`.padEnd(width + 1);
    const turns = `${agent.turns} turn${agent.turns === 1 ? '' : 's'}`;
    if (agent.counted === 0) {
      lines.push(`${head}${turns}, tokens not counted by the agent`);
    } else {
      const parts = [`${figure(agent.inputTokens)} in`, `${figure(agent.outputTokens)} out`];
      if (agent.cachedTokens > 0) parts.push(`${figure(agent.cachedTokens)} cached`);
      const uncounted = agent.turns - agent.counted;
      lines.push(
        `${head}${turns}, ${figure(agent.tokens)} tokens (${parts.join(' + ')})` +
          (uncounted > 0 ? `; ${uncounted} not counted` : ''),
      );
    }
    if (agent.context && agent.context.size > 0) {
      const percent = Math.round((agent.context.used / agent.context.size) * 100);
      lines.push(
        `${' '.repeat(width + 1)}context ${figure(agent.context.used)} of ${figure(agent.context.size)} (${percent}%)`,
      );
    }
  }
  if (tasks.length > 0) {
    const said = sum(tasks, (r) => r.replyChars);
    const relayed = sum(tasks, (r) => r.relayedChars);
    lines.push(
      `tasks:   ${tasks.length}, briefs ${figure(sum(tasks, (r) => r.promptChars))} chars sent ` +
        `(avg ${figure(Math.round(sum(tasks, (r) => r.promptChars) / tasks.length))})`,
      `         agents said ${figure(said)} chars; the planner was handed ${figure(relayed)}` +
        (said > 0 ? ` (${Math.round((relayed / said) * 100)}%)` : ''),
    );
  } else {
    lines.push('tasks:   none yet');
  }
  const charges = host.transcript.all().filter((record) => record.type === 'budget_usage').map((record) => record.usage);
  if (charges.length) {
    lines.push(`run: ${figure(charges.reduce((n, u) => n + u.tokens, 0))} tokens; ${figure(charges.reduce((n, u) => n + u.frontierTokens, 0))} frontier tokens`);
    const missing = charges.filter((u) => u.costUsd === undefined && u.tokens > 0).length;
    lines.push(`known cost: $${charges.reduce((n, u) => n + (u.costUsd ?? 0), 0).toFixed(6)}; ${missing} calls without prices; ${charges.filter((u) => u.estimated).length} estimated calls`);
  }
  return lines;
}

function figure(n: number): string {
  return n.toLocaleString('en-US');
}

/** Approximate token count, on a character total. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function help(host: CommandHost): string[] {
  const width = Math.max(
    ...host.commands.map((command) => `/${command.name}${hint(command)}`.length),
  );
  const lines: string[] = [];
  for (const source of ['builtin', 'project', 'user'] as const) {
    const group = host.commands.filter((command) => command.source === source);
    if (group.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`${source}:`);
    for (const command of group) {
      const named = `/${command.name}${hint(command)}`;
      const alias = command.aliases?.length ? ` (${command.aliases.map((a) => `/${a}`).join(', ')})` : '';
      lines.push(`  ${named.padEnd(width)}  ${command.description}${alias}`);
    }
  }

  lines.push('');
  for (const { dir, source } of commandSearchPaths()) {
    lines.push(`${source} commands: ${tildify(dir)}/*.md`);
  }
  lines.push(
    'shift+tab cycles the permission mode — ask, bypass; /config shows the current one',
    'a command file can carry !`cmd` and @file; both are judged like an agent’s own,',
    `and commands run in the workspace — ${tildify(host.workspace.dir)}`,
  );
  return lines;
}

function agents(host: CommandHost): string[] {
  const orchestration = host.config.orchestration;
  const lines = Object.entries(host.config.agents).map(([id, profile]) => {
    const state = profile.enabled ? 'on ' : 'off';
    const launch = [profile.command, ...profile.args].join(' ');
    // The role as the planner has it, so a `roles` entry that overrode the
    // profile's note shows here rather than the line it replaced.
    const role = agentRole(host.config, id);
    return `  ${state}  ${id.padEnd(8)}  ${launch}${role ? ` — ${role}` : ''}`;
  });
  lines.push('');
  const planner = orchestrationModel(host.config);
  lines.push(
    orchestration.provider === 'acp'
      ? `routing: ${orchestration.acp.agent} over acp${planner ? ` on ${planner}` : ''}`
      : `routing: ${orchestration.local.model} at ${orchestration.local.baseURL}`,
  );
  return lines;
}

function configuration(host: CommandHost): string[] {
  return [
    `read from:  ${readFrom(host)}`,
    `workspace:  ${tildify(host.workspace.dir)}`,
    `transcript: ${tildify(host.workspace.transcriptFile)}`,
    '',
    modeLine(host.policy.mode),
    host.config.capabilities.elicitation
      ? 'q&a:  agents may stop and ask you a question of their own'
      : 'q&a:  off — an agent that needs an answer has to end its turn to ask',
  ];
}

/**
 * The permission mode, said with what it does to the lines above it. It is
 * not read from any file, which is why it stands apart from them and names
 * the two ways it is set.
 */
function modeLine(mode: PermissionMode): string {
  const how = 'shift+tab in the UI, --permission-mode with run';
  switch (mode) {
    case 'ask':
      return `mode: ask — every question comes to you (${how})`;
    case 'bypass':
      return `mode: bypass — every permission request is allowed (${how})`;
  }
}

/**
 * Where the settings came from, said so the precedence is visible: two files
 * that both had something to say are named in the order they won, because
 * "why is this setting not what my config says" is nearly always answered by
 * the other file.
 */
function readFrom(host: CommandHost): string {
  if (host.configSources.length === 0) return 'nowhere — these are the defaults';
  return host.configSources
    .map((source) => `${tildify(source.file)} (${source.scope})`)
    .join(' over ');
}

function hint(command: Command): string {
  return command.argumentHint ? ` ${command.argumentHint}` : '';
}

function tildify(target: string): string {
  const home = os.homedir();
  return home && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}
