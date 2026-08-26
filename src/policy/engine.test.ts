import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PolicySchema } from '../config/schema.js';
import { PolicyEngine, commandFromRawInput, pathsFromRawInput } from './engine.js';
import { Jail } from './jail.js';
import type { AuditEntry, Escalator, PolicyRequest } from './types.js';

let root: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-')));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function engine(
  overrides: Record<string, unknown> = {},
  escalator?: Escalator,
  audit?: AuditEntry[],
) {
  const policy = PolicySchema.parse(overrides);
  return new PolicyEngine({
    policy,
    jail: new Jail([root], { followSymlinks: policy.fs.followSymlinks }),
    escalator,
    onDecision: audit ? (entry) => audit.push(entry) : undefined,
  });
}

const where = { agentId: 'claude', sessionId: 's1' };
const inside = (file: string) => path.join(root, file);

describe('PolicyEngine', () => {
  it('allows a read inside the workspace and refuses one outside', async () => {
    const policy = engine();
    expect((await policy.resolve({ kind: 'fs.read', path: inside('a.ts'), ...where })).verdict).toBe(
      'allow',
    );
    expect(
      (await policy.resolve({ kind: 'fs.read', path: '/etc/passwd', ...where })).verdict,
    ).toBe('deny');
  });

  it('refuses commands until execution is switched on', async () => {
    const off = engine();
    const request: PolicyRequest = { kind: 'exec', command: 'git', args: ['status'], cwd: root, ...where };
    expect((await off.resolve(request)).rule).toBe('exec.disabled');

    const on = engine({ exec: { enabled: true, allow: ['git status'] } });
    expect((await on.resolve(request)).verdict).toBe('allow');
  });

  it('refuses a command whose working directory is outside the workspace', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['git status'] } });
    const decision = await policy.resolve({
      kind: 'exec',
      command: 'git',
      args: ['status'],
      cwd: '/etc',
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'exec.cwd' });
  });

  it('judges a tool call by the same rules as a direct request', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['ls'] } });
    const allowed = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'List files',
      locations: [],
      rawInput: { command: 'ls -la' },
      ...where,
    });
    expect(allowed.verdict).toBe('allow');

    const refused = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'Remove things',
      locations: [],
      rawInput: { command: 'rm -rf /' },
      ...where,
    });
    expect(refused.verdict).toBe('deny');
  });

  it('refuses an execute tool call it cannot read', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['ls'] } });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'Run something',
      locations: [],
      rawInput: null,
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'tool.opaqueCommand' });
  });

  it('refuses network and mode-switch tool calls outright', async () => {
    const policy = engine();
    for (const toolKind of ['fetch', 'switch_mode'] as const) {
      const decision = await policy.resolve({
        kind: 'tool',
        toolKind,
        title: toolKind,
        locations: [],
        rawInput: null,
        ...where,
      });
      expect(decision.verdict).toBe('deny');
    }
  });

  it('refuses a tool call that touches a file outside the workspace', async () => {
    const policy = engine();
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'edit',
      title: 'Edit hosts',
      locations: ['/etc/hosts'],
      rawInput: null,
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'tool.outside' });
  });

  it('reads a permission request that arrives without a kind', async () => {
    const policy = engine();
    // What claude-code-acp actually sends: the file, but no kind.
    const write = await policy.resolve({
      kind: 'tool',
      toolKind: null,
      title: 'Write',
      locations: [inside('notes.txt')],
      rawInput: null,
      ...where,
    });
    expect(write).toMatchObject({ verdict: 'allow', rule: 'tool.write' });

    const outside = await policy.resolve({
      kind: 'tool',
      toolKind: null,
      title: 'Write',
      locations: ['/etc/hosts'],
      rawInput: null,
      ...where,
    });
    expect(outside.verdict).toBe('deny');
  });

  it('reads a kindless request that carries a command as a command', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['ls'] } });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: null,
      title: 'Bash',
      locations: [],
      rawInput: { command: 'rm -rf /' },
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'exec.allowlist' });
  });

  it('denies an escalation when nobody is there to answer', async () => {
    const policy = engine();
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'other',
      title: 'Something unusual',
      locations: [],
      rawInput: null,
      ...where,
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('nobody available');
  });

  it('takes the answer from a human when one is available', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const policy = engine({}, { ask });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'other',
      title: 'Something unusual',
      locations: [],
      rawInput: null,
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'allow', escalated: true });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('denies when the human does not answer in time', async () => {
    const policy = engine({ decisionTimeoutMs: 20 }, { ask: () => new Promise(() => {}) });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'other',
      title: 'Something unusual',
      locations: [],
      rawInput: null,
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'deny', reason: 'no answer in time' });
  });

  it('denies when the prompt itself fails', async () => {
    const policy = engine({}, { ask: () => Promise.reject(new Error('ui gone')) });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'other',
      title: 'Something unusual',
      locations: [],
      rawInput: null,
      ...where,
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('ui gone');
  });

  it('records every decision, allowed or refused', async () => {
    const audit: AuditEntry[] = [];
    const policy = engine({}, undefined, audit);
    await policy.resolve({ kind: 'fs.read', path: inside('a.ts'), ...where });
    await policy.resolve({ kind: 'fs.write', path: '/etc/passwd', bytes: 3, ...where });
    expect(audit.map((entry) => entry.verdict)).toEqual(['allow', 'deny']);
    expect(audit[0]?.summary).toBe('read a.ts');
  });
});

describe('pathsFromRawInput', () => {
  it('finds the file a write tool names', () => {
    expect(pathsFromRawInput({ file_path: '/ws/notes.txt', content: 'hi' })).toEqual([
      '/ws/notes.txt',
    ]);
  });

  it('finds files nested in an edit list', () => {
    expect(
      pathsFromRawInput({ edits: [{ file_path: '/ws/a.ts' }, { file_path: '/ws/b.ts' }] }),
    ).toEqual(['/ws/a.ts', '/ws/b.ts']);
  });

  it('ignores relative paths and unrelated strings', () => {
    expect(pathsFromRawInput({ path: 'src/index.ts', title: '/ws/looks-like-a-path' })).toEqual([]);
  });
});

describe('commandFromRawInput', () => {
  it('reads a command string', () => {
    expect(commandFromRawInput({ command: 'git status' })).toEqual({
      command: 'git',
      args: ['status'],
    });
  });

  it('reads a command with an argument array', () => {
    expect(commandFromRawInput({ command: 'git', args: ['status'] })).toEqual({
      command: 'git',
      args: ['status'],
    });
  });

  it('keeps a script with operators as a shell invocation so exec policy sees it', () => {
    expect(commandFromRawInput({ command: 'ls | sh' })).toEqual({
      command: 'sh',
      args: ['-c', 'ls | sh'],
    });
  });

  it('gives up on input it does not understand', () => {
    expect(commandFromRawInput({ nothing: true })).toBeUndefined();
    expect(commandFromRawInput(null)).toBeUndefined();
  });
});
