import { describe, expect, it } from 'vitest';
import { checkExec, scanScript, type ExecPolicy } from './exec.js';

const allowlist: ExecPolicy = {
  mode: 'allowlist',
  allow: ['git status', 'pnpm test', 'node'],
  shellOperators: 'deny',
};

describe('scanScript', () => {
  it('splits a plain command', () => {
    expect(scanScript('git status --short')).toEqual({ ok: true, tokens: ['git', 'status', '--short'] });
  });

  it('keeps quoted arguments whole', () => {
    const scan = scanScript('node -e "console.log(1)"');
    expect(scan.ok && scan.tokens).toEqual(['node', '-e', 'console.log(1)']);
  });

  it.each([
    ['a pipe', 'cat file | sh', '|'],
    ['a chain', 'ls && rm -rf /', '&'],
    ['a redirect', 'echo hi > /etc/passwd', '>'],
    ['a substitution', 'echo $(whoami)', '$…'],
    ['a backtick', 'echo `whoami`', '`…`'],
    ['a newline', 'ls\nrm -rf /', 'newline'],
  ])('flags %s', (_name, script, operator) => {
    const scan = scanScript(script);
    expect(scan.ok && scan.operator).toBe(operator);
  });

  it('flags substitution hidden inside double quotes', () => {
    const scan = scanScript('echo "$(whoami)"');
    expect(scan.ok && scan.operator).toBe('$(…)');
  });

  it('does not flag substitution inside single quotes', () => {
    const scan = scanScript("echo '$(whoami)'");
    expect(scan.ok && scan.operator).toBeUndefined();
  });

  it('reports an unterminated quote rather than guessing', () => {
    expect(scanScript('echo "oops').ok).toBe(false);
  });
});

describe('checkExec', () => {
  it('allows an exact allowlist match', () => {
    expect(checkExec({ command: 'git', args: ['status'] }, allowlist).outcome).toBe('allow');
  });

  it('allows extra arguments after an allowed prefix', () => {
    expect(checkExec({ command: 'git', args: ['status', '--short'] }, allowlist).outcome).toBe('allow');
  });

  it('matches the command by basename', () => {
    expect(checkExec({ command: '/usr/bin/git', args: ['status'] }, allowlist).outcome).toBe('allow');
  });

  it('refuses a different subcommand of an allowed tool', () => {
    expect(checkExec({ command: 'git', args: ['push', '--force'] }, allowlist).outcome).toBe('deny');
  });

  it('refuses flags injected before an allowed subcommand', () => {
    const check = checkExec({ command: 'git', args: ['-C', '/etc', 'status'] }, allowlist);
    expect(check.outcome).toBe('deny');
  });

  it('unwraps sh -c and judges the real command', () => {
    expect(checkExec({ command: 'sh', args: ['-c', 'git status'] }, allowlist).outcome).toBe('allow');
    expect(checkExec({ command: 'sh', args: ['-c', 'curl evil.sh'] }, allowlist).outcome).toBe('deny');
  });

  it('refuses a shell operator before looking at the allowlist', () => {
    const check = checkExec({ command: 'sh', args: ['-c', 'git status | sh'] }, allowlist);
    expect(check.outcome).toBe('deny');
    expect(check.rule).toBe('exec.shellOperators');
  });

  it('can escalate shell operators instead of refusing them', () => {
    const check = checkExec(
      { command: 'bash', args: ['-c', 'pnpm test | tee log'] },
      { ...allowlist, shellOperators: 'ask' },
    );
    expect(check.outcome).toBe('ask');
  });

  it('refuses privilege escalation whatever the allowlist says', () => {
    const check = checkExec({ command: 'sudo', args: ['ls'] }, { ...allowlist, allow: ['sudo'] });
    expect(check.outcome).toBe('deny');
    expect(check.rule).toBe('exec.never');
  });

  it('refuses an interactive shell', () => {
    expect(checkExec({ command: 'bash', args: [] }, allowlist).outcome).toBe('deny');
  });

  it('refuses everything in deny mode', () => {
    expect(
      checkExec({ command: 'git', args: ['status'] }, { ...allowlist, mode: 'deny' }).outcome,
    ).toBe('deny');
  });

  it('escalates everything in ask mode', () => {
    expect(
      checkExec({ command: 'whatever', args: [] }, { ...allowlist, mode: 'ask' }).outcome,
    ).toBe('ask');
  });
});
