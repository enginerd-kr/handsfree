import { describe, expect, it } from 'vitest';
import { checkExec, scanChain, scanScript, type ExecPolicy } from './exec.js';

const allowlist: ExecPolicy = {
  mode: 'allowlist',
  allow: ['git status', 'pnpm test', 'node'],
  otherwise: 'deny',
  shellOperators: 'deny',
};

describe('exec.otherwise', () => {
  const command = { command: 'git', args: ['commit', '-m', 'wip'] };

  it('asks about a command the allowlist does not name', () => {
    const check = checkExec(command, { ...allowlist, otherwise: 'ask' });
    expect(check).toMatchObject({ outcome: 'ask', rule: 'exec.otherwise' });
  });

  it('refuses it when the settings say so', () => {
    expect(checkExec(command, allowlist)).toMatchObject({
      outcome: 'deny',
      rule: 'exec.otherwise',
    });
  });

  it('leaves the allowlist itself silent', () => {
    expect(checkExec({ command: 'git', args: ['status'] }, { ...allowlist, otherwise: 'ask' })).toMatchObject({
      outcome: 'allow',
      rule: 'exec.allow:git status',
    });
  });

  it('never turns a refused command into a question because a pipe followed it', () => {
    const piped = { command: 'sh', args: ['-c', 'sudo rm -rf / | tee log'] };
    expect(checkExec(piped, { ...allowlist, otherwise: 'ask', shellOperators: 'ask' })).toMatchObject({
      outcome: 'deny',
      rule: 'exec.never',
    });
  });
});

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

describe('checkExec on a chain', () => {
  const sh = (script: string) => ({ command: 'sh', args: ['-c', script] });

  it('allows a chain whose every link the allowlist names', () => {
    // Copied from a real claude-code turn: two allowed commands, joined.
    const check = checkExec(sh("node --version && node --experimental-strip-types -e 'import(\"./src/parser.ts\")'"), allowlist);
    expect(check).toMatchObject({ outcome: 'allow', rule: 'exec.allow:chain(node; node)' });
  });

  it('allows a cd into the workspace at the head of a chain, and nowhere else', () => {
    const inside = { ...allowlist, allowCd: (dir: string) => dir.startsWith('/ws') };
    expect(checkExec(sh('cd /ws/src && pnpm test'), inside)).toMatchObject({ outcome: 'allow', rule: 'exec.allow:chain(cd; pnpm test)' });
    expect(checkExec(sh('cd /etc && pnpm test'), inside)).toMatchObject({ outcome: 'deny', rule: 'exec.shellOperators' });
    expect(checkExec(sh('cd /ws/src && pnpm test'), allowlist)).toMatchObject({ outcome: 'deny', rule: 'exec.shellOperators' });
  });

  it('judges pipes, semicolons and || the same way', () => {
    expect(checkExec(sh('git status | node filter.js'), allowlist).outcome).toBe('allow');
    expect(checkExec(sh('git status; node a.js'), allowlist).outcome).toBe('allow');
    expect(checkExec(sh('pnpm test || node explain.js'), allowlist).outcome).toBe('allow');
  });

  it('still treats a chain with a link nobody allowed as a shell operator', () => {
    expect(checkExec(sh('node a.js && rm -rf /'), allowlist)).toMatchObject({ outcome: 'deny', rule: 'exec.shellOperators' });
    expect(checkExec(sh('node a.js && curl x'), { ...allowlist, shellOperators: 'ask' })).toMatchObject({ outcome: 'ask' });
  });

  it('refuses a chain with a never-command anywhere in it', () => {
    expect(checkExec(sh('node a.js && sudo rm -rf /'), { ...allowlist, shellOperators: 'ask' })).toMatchObject({ outcome: 'deny', rule: 'exec.never' });
  });

  it('does not read a redirect, a substitution or a lone & as a chain', () => {
    expect(checkExec(sh('node a.js > out.txt'), allowlist)).toMatchObject({ outcome: 'deny', rule: 'exec.shellOperators' });
    expect(checkExec(sh('node a.js && node $(cat x)'), allowlist)).toMatchObject({ outcome: 'deny', rule: 'exec.shellOperators' });
    expect(checkExec(sh('node a.js & node b.js'), allowlist)).toMatchObject({ outcome: 'deny', rule: 'exec.shellOperators' });
  });

  it('lets otherwise=allow pass links the list does not name', () => {
    expect(checkExec(sh('node a.js && curl x'), { ...allowlist, otherwise: 'allow' }).outcome).toBe('allow');
  });
});

describe('scanChain', () => {
  it('splits on the chain operators and keeps quoted text whole', () => {
    const chain = scanChain(`cd /ws && node -e 'a && b' | tee`);
    expect(chain).toEqual({ ok: true, segments: [['cd', '/ws'], ['node', '-e', 'a && b'], ['tee']] });
  });

  it('refuses an empty link', () => {
    expect(scanChain('node a.js &&').ok).toBe(false);
    expect(scanChain('| node').ok).toBe(false);
  });
});
