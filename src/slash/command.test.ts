import { describe, expect, it } from 'vitest';
import {
  findCommand,
  looksLikeCommand,
  parseSlashCommand,
  suggest,
  takesArguments,
  type Command,
} from './command.js';

function local(name: string, description = '', extra: Partial<Command> = {}): Command {
  return { kind: 'local', name, description, source: 'builtin', run: () => ({ do: 'reset' }), ...extra } as Command;
}

function prompt(name: string, argNames: string[] = []): Command {
  return {
    kind: 'prompt',
    name,
    description: 'a command file',
    source: 'project',
    argNames,
    body: '',
    file: `${name}.md`,
  };
}

describe('parseSlashCommand', () => {
  it('splits the name from everything after it', () => {
    expect(parseSlashCommand('/review src/policy engine')).toEqual({
      name: 'review',
      args: 'src/policy engine',
    });
  });

  it('keeps a namespace intact', () => {
    expect(parseSlashCommand('/frontend:deploy')).toEqual({ name: 'frontend:deploy', args: '' });
  });

  it('ignores the whitespace around the line', () => {
    expect(parseSlashCommand('   /help   ')).toEqual({ name: 'help', args: '' });
  });

  it('is nothing when the slash is not first', () => {
    expect(parseSlashCommand('fix the /help page')).toBeUndefined();
  });

  it('is nothing for a bare slash', () => {
    expect(parseSlashCommand('/')).toBeUndefined();
    expect(parseSlashCommand('/  ')).toBeUndefined();
  });
});

describe('looksLikeCommand', () => {
  it('accepts what a command name can be made of', () => {
    expect(looksLikeCommand('help')).toBe(true);
    expect(looksLikeCommand('frontend:deploy')).toBe(true);
    expect(looksLikeCommand('fix_it-now')).toBe(true);
  });

  // A path typed into the prompt must reach the model as the text it is,
  // rather than being refused as a command nobody wrote.
  it('rejects anything shaped like a path', () => {
    expect(looksLikeCommand('usr/local/bin/foo')).toBe(false);
    expect(looksLikeCommand('tmp/x.log')).toBe(false);
  });
});

describe('findCommand', () => {
  const commands = [local('exit', 'leave', { aliases: ['quit'] }), local('help')];

  it('finds by name, by alias, and in any case', () => {
    expect(findCommand('exit', commands)?.name).toBe('exit');
    expect(findCommand('quit', commands)?.name).toBe('exit');
    expect(findCommand('HELP', commands)?.name).toBe('help');
  });

  it('finds nothing for a name nobody claimed', () => {
    expect(findCommand('nope', commands)).toBeUndefined();
  });
});

describe('suggest', () => {
  const commands = [
    local('help', 'what you can type'),
    local('reset', 'start over'),
    local('exit', 'leave', { aliases: ['quit'] }),
    prompt('review'),
  ];

  it('offers everything for a bare slash', () => {
    expect(suggest('/', commands)).toHaveLength(4);
  });

  it('offers nothing when the line is not a command', () => {
    expect(suggest('fix the tests', commands)).toEqual([]);
  });

  // Once there is a space the command has been chosen; what is being written
  // now is its arguments, and a menu over them is in the way.
  it('offers nothing once arguments have started', () => {
    expect(suggest('/review src', commands)).toEqual([]);
  });

  it('puts an exact name before a longer prefix match', () => {
    const names = suggest('/re', commands).map((command) => command.name);
    expect(names).toEqual(['reset', 'review']);
  });

  it('reaches an alias', () => {
    expect(suggest('/qu', commands).map((command) => command.name)).toEqual(['exit']);
  });

  it('falls back to the description when no name matches', () => {
    expect(suggest('/leave', commands).map((command) => command.name)).toEqual(['exit']);
  });
});

describe('takesArguments', () => {
  it('is true for a hint or a named argument, false otherwise', () => {
    expect(takesArguments(local('help'))).toBe(false);
    expect(takesArguments(prompt('review'))).toBe(false);
    expect(takesArguments(prompt('deploy', ['target']))).toBe(true);
    expect(takesArguments(local('open', '', { argumentHint: '[path]' }))).toBe(true);
  });
});
