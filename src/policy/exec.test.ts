import { describe, expect, it } from 'vitest';
import { scanScript } from './exec.js';

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
