import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, tooBroadToAttach } from './main.js';

describe('parseArgs', () => {
  it('leaves the workspace attached by default', () => {
    expect(parseArgs([]).sandbox).toBe(false);
    expect(parseArgs(['run', 'fix the tests']).sandbox).toBe(false);
  });

  it('takes --sandbox anywhere in the line', () => {
    const args = parseArgs(['run', '--sandbox', 'draft a script']);
    expect(args.sandbox).toBe(true);
    expect(args.prompt).toBe('draft a script');
  });

  it('takes --permission-mode as typed, and leaves it unset otherwise', () => {
    const args = parseArgs(['run', '--permission-mode', 'bypass', 'go']);
    expect(args.permissionMode).toBe('bypass');
    expect(args.prompt).toBe('go');
    expect(parseArgs(['run', 'go']).permissionMode).toBeUndefined();
    // Not judged here: a misspelling is main's to refuse with a message.
    expect(parseArgs(['run', '--permission-mode', 'yolo', 'go']).permissionMode).toBe('yolo');
  });
});

describe('tooBroadToAttach', () => {
  it('allows an ordinary project directory', () => {
    expect(tooBroadToAttach(path.join(os.homedir(), 'work', 'handsfree'))).toBeUndefined();
  });

  it('refuses the home directory, however it is spelled', () => {
    const home = '/Users/someone';
    expect(tooBroadToAttach(home, home)).toMatch(/home directory/);
    expect(tooBroadToAttach(`${home}/projects/..`, home)).toMatch(/home directory/);
  });

  it('refuses the filesystem root', () => {
    expect(tooBroadToAttach(path.parse(process.cwd()).root)).toMatch(/filesystem root/);
  });

  it('names both ways forward', () => {
    const refusal = tooBroadToAttach('/Users/someone', '/Users/someone') ?? '';
    expect(refusal).toMatch(/cd into a project/);
    expect(refusal).toMatch(/--sandbox/);
  });
});
