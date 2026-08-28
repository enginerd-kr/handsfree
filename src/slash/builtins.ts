import os from 'node:os';
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
      name: 'reset',
      description: 'forget the conversation and start over',
      source: 'builtin',
      run: () => ({ do: 'reset' }),
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
  ];
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
    'a command file can carry !`cmd` and @file; both are judged like an agent’s own,',
    host.config.policy.exec.enabled
      ? `and commands run in the workspace — ${tildify(host.workspace.dir)}`
      : 'and running commands is switched off, so every !`cmd` will be refused',
  );
  return lines;
}

function agents(host: CommandHost): string[] {
  const orchestration = host.config.orchestration;
  const lines = Object.entries(host.config.agents).map(([id, profile]) => {
    const state = profile.enabled ? 'on ' : 'off';
    const launch = [profile.command, ...profile.args].join(' ');
    return `  ${state}  ${id.padEnd(8)}  ${launch}${profile.note ? ` — ${profile.note}` : ''}`;
  });
  lines.push('');
  lines.push(
    orchestration.provider === 'acp'
      ? `routing: ${orchestration.acp.agent} over acp`
      : `routing: ${orchestration.local.model} at ${orchestration.local.baseURL}`,
  );
  return lines;
}

function configuration(host: CommandHost): string[] {
  const { policy } = host.config;
  return [
    `read from:  ${readFrom(host)}`,
    `workspace:  ${tildify(host.workspace.dir)}`,
    `transcript: ${tildify(host.workspace.transcriptFile)}`,
    '',
    `fs:   read ${policy.fs.read}, write ${policy.fs.write}, outside ${policy.fs.outside}`,
    policy.exec.enabled
      ? `exec: ${policy.exec.mode}, shell operators ${policy.exec.shellOperators}, allowing ${policy.exec.allow.join(', ') || 'nothing'}`
      : 'exec: off — no command runs, whoever asks',
    `ask:  ${policy.escalation.join(', ') || 'nobody'}, within ${Math.round(policy.decisionTimeoutMs / 1000)}s`,
  ];
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
