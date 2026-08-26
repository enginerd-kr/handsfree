import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, FORBIDDEN_ARG_PATTERNS } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';
import { claudeAdapter } from './claude.js';
import { geminiAdapter } from './gemini.js';
import { codexAdapter } from './codex.js';

const config = ConfigSchema.parse({});
const runDir = path.join(os.tmpdir(), 'hf-test-run');
const task: TaskPaths = {
  id: 1,
  agent: 'claude',
  dir: path.join(runDir, 'tasks', '1-claude'),
  briefFile: path.join(runDir, 'tasks', '1-claude', 'brief.md'),
  resultFile: path.join(runDir, 'tasks', '1-claude', 'result.md'),
  rawFile: path.join(runDir, 'tasks', '1-claude', 'raw.json'),
  lastMessageFile: path.join(runDir, 'tasks', '1-claude', 'last-message.txt'),
};

describe.each([claudeAdapter, geminiAdapter, codexAdapter])('$name adapter', (adapter) => {
  const inv = adapter.buildInvocation('do the thing', task, runDir, config);

  it('never emits a forbidden flag', () => {
    for (const arg of inv.args) {
      for (const { pattern } of FORBIDDEN_ARG_PATTERNS) {
        expect(arg).not.toMatch(pattern);
      }
    }
  });

  it('uses minimum-scope permissions', () => {
    const joined = inv.args.join(' ');
    if (adapter.name === 'claude') {
      expect(joined).toContain('--permission-mode acceptEdits');
      expect(joined).toContain('--output-format json');
    }
    if (adapter.name === 'gemini') {
      expect(joined).toContain('--approval-mode auto_edit');
      // prompt must be positional (last), not via deprecated -p
      expect(inv.args.at(-1)).toBe('do the thing');
    }
    if (adapter.name === 'codex') {
      expect(joined).toContain('-s workspace-write');
      expect(joined).toContain('--skip-git-repo-check');
    }
  });
});

describe('claude output parsing', () => {
  const out = (stdout: string, stderr = '') => claudeAdapter.parseOutput({ stdout, stderr }, task);

  it('detects permission denials in structured output', () => {
    const parsed = out(
      JSON.stringify({
        result: 'I could not finish',
        is_error: false,
        permission_denials: [{ tool_name: 'Bash' }],
      }),
    );
    expect(parsed.denials.length).toBeGreaterThan(0);
  });

  it('extracts result text', () => {
    const parsed = out(JSON.stringify({ result: 'done', is_error: false }));
    expect(parsed.finalMessage).toBe('done');
    expect(parsed.denials).toEqual([]);
  });

  it('is not corrupted by anything the CLI writes to stderr', () => {
    const parsed = out(
      JSON.stringify({ result: 'done', is_error: false }),
      'warning: update available\nnode: ExperimentalWarning\n',
    );
    expect(parsed.finalMessage).toBe('done');
    expect(parsed.isError).toBe(false);
  });

  it('tolerates a banner printed before the JSON payload', () => {
    const parsed = out(`Update available!\n${JSON.stringify({ result: 'done', is_error: false })}`);
    expect(parsed.finalMessage).toBe('done');
  });

  it('reports an error when the promised JSON never arrives', () => {
    const parsed = out('', 'Error: not logged in\n');
    expect(parsed.isError).toBe(true);
    expect(parsed.finalMessage).toContain('not logged in');
  });
});

describe('codex output parsing', () => {
  it('takes the last agent message from the JSONL stream', () => {
    const stdout = [
      JSON.stringify({ msg: { type: 'agent_message', message: 'first' } }),
      'not json at all',
      JSON.stringify({ msg: { type: 'agent_message', message: 'second' } }),
    ].join('\n');
    const parsed = codexAdapter.parseOutput({ stdout, stderr: '' }, task);
    expect(parsed.finalMessage).toBe('second');
    expect(parsed.isError).toBe(false);
  });

  it('flags error events, and treats a denial named in one as structural', () => {
    const stdout = JSON.stringify({
      msg: { type: 'error', message: 'sandbox denied write outside the workspace' },
    });
    const parsed = codexAdapter.parseOutput({ stdout, stderr: '' }, task);
    expect(parsed.isError).toBe(true);
    expect(parsed.denials.length).toBeGreaterThan(0);
  });
});

describe('gemini output parsing', () => {
  it('surfaces a structured error as an error', () => {
    const stdout = JSON.stringify({ error: { message: 'quota exceeded' } });
    const parsed = geminiAdapter.parseOutput({ stdout, stderr: '' }, task);
    expect(parsed.isError).toBe(true);
    expect(parsed.finalMessage).toBe('quota exceeded');
  });
});
