import { describe, expect, it } from 'vitest';
import { COMMANDS, formatHelp, formatTasks, matchCommands, resolveCommand } from './commands.js';
import type { TaskRecord } from './useOrchestrator.js';

describe('matchCommands', () => {
  it('lists every command for a bare slash', () => {
    expect(matchCommands('/')).toHaveLength(COMMANDS.length);
  });

  it('filters by prefix', () => {
    expect(matchCommands('/he').map((c) => c.name)).toEqual(['help']);
    expect(matchCommands('/t').map((c) => c.name)).toEqual(['tasks']);
  });

  it('matches aliases', () => {
    expect(matchCommands('/qu').map((c) => c.name)).toEqual(['exit']);
  });

  it('ignores non-slash input and unknown prefixes', () => {
    expect(matchCommands('hello')).toEqual([]);
    expect(matchCommands('/zzz')).toEqual([]);
  });

  it('ignores arguments after the command word', () => {
    expect(matchCommands('/help me please').map((c) => c.name)).toEqual(['help']);
  });
});

describe('resolveCommand', () => {
  it('resolves exact names and aliases', () => {
    expect(resolveCommand('/exit')?.name).toBe('exit');
    expect(resolveCommand('/quit')?.name).toBe('exit');
  });

  it('does not resolve partial input', () => {
    expect(resolveCommand('/he')).toBeUndefined();
  });
});

describe('formatters', () => {
  it('help lists every command', () => {
    const help = formatHelp();
    for (const c of COMMANDS) expect(help).toContain(`/${c.name}`);
  });

  it('tasks renders status and duration', () => {
    const tasks: TaskRecord[] = [
      { id: 1, agent: 'claude', task: 'do a thing', status: 'success', startedAt: 0, endedAt: 65_000 },
    ];
    const out = formatTasks(tasks);
    expect(out).toContain('#1');
    expect(out).toContain('success');
    expect(out).toContain('1m 5s');
    expect(formatTasks([])).toContain('No tasks');
  });
});
