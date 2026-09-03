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

  it('runs what the default allowlist names, and nothing once execution is off', async () => {
    const request: PolicyRequest = { kind: 'exec', command: 'git', args: ['status'], cwd: root, ...where };
    expect((await engine().resolve(request)).verdict).toBe('allow');

    const off = engine({ exec: { enabled: false } });
    expect((await off.resolve(request)).rule).toBe('exec.disabled');
  });

  it('puts a command the allowlist does not name to the person, not to a rule', async () => {
    const asked: string[] = [];
    const escalator: Escalator = {
      ask: (request) => {
        asked.push(request.summary);
        return Promise.resolve(true);
      },
    };
    const request: PolicyRequest = {
      kind: 'exec',
      command: 'git',
      args: ['commit', '-m', 'wip'],
      cwd: root,
      ...where,
    };
    const decision = await engine({}, escalator).resolve(request);
    expect(decision).toMatchObject({ verdict: 'allow', rule: 'exec.otherwise', escalated: true });
    expect(asked).toEqual(['run git commit -m wip']);

    // The same request with nobody to ask — `handsfree run`, CI — is a denial.
    expect((await engine().resolve(request)).verdict).toBe('deny');
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

  // The four titles below are what gemini-cli 0.57 sends: no rawInput, and
  // the command itself as the title.
  it('judges a command an agent states only in the title, as gemini does', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['node'] } });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'node --experimental-strip-types test.mjs',
      locations: [],
      rawInput: null,
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'allow', rule: 'exec.allow:node' });
  });

  it('puts a title-only command the allowlist does not name to the usual question', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['node'] } });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'rm -rf build',
      locations: [],
      rawInput: null,
      ...where,
    });
    // Headless, a question is a refusal — by the exec rule, not as unreadable.
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'exec.otherwise' });
  });

  it('sees the shell operators in a title-only command', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['node'] } });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'node test.mjs && rm -rf /',
      locations: [],
      rawInput: null,
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'exec.shellOperators' });
  });

  it('leaves an execute tool call it cannot read to a person, and refuses it without one', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['ls'] } });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'echo "an unbalanced quote',
      locations: [],
      rawInput: null,
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'tool.opaqueCommand' });
  });

  it('refuses network and mode-switch tool calls outright', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['curl'] } });
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

      // Still their own refusal, not the allowlist's, even when an argv rides along.
      const withArgv = await policy.resolve({
        kind: 'tool',
        toolKind,
        title: toolKind,
        locations: [],
        rawInput: { command: ['curl', 'https://example.com'] },
        ...where,
      });
      expect(withArgv).toMatchObject({ verdict: 'deny', rule: `tool.${toolKind === 'fetch' ? 'fetch' : 'switchMode'}` });
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
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'exec.otherwise' });
  });

  // The three shapes below are copied from a real codex-acp 0.16.0 turn.
  it('judges the argv codex states as an array, not as an opaque command', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['ls'] } });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'Run ls',
      locations: [],
      rawInput: { call_id: 'call_1', command: ['/bin/zsh', '-lc', 'ls'], cwd: root },
      ...where,
    });
    expect(decision).toMatchObject({ verdict: 'allow', rule: 'exec.allow:ls' });
  });

  it('refuses a chained codex command as a chain, not as a shrug', async () => {
    const policy = engine({ exec: { enabled: true, allow: ['mkdir', 'echo'] } });
    const decision = await policy.resolve({
      kind: 'tool',
      toolKind: 'execute',
      title: 'Run mkdir',
      locations: [],
      rawInput: { command: ['/bin/zsh', '-lc', 'mkdir -p /tmp/x && echo done'], cwd: root },
      ...where,
    });
    // The verdict is still no, but it is a judgement about the `&&` rather than
    // an admission that we could not read the request.
    expect(decision).toMatchObject({ verdict: 'deny', rule: 'exec.shellOperators' });
  });

  it('judges a command by its argv even when the agent calls it a search', async () => {
    // codex labels a shell call by what it thinks the command means: `ls`
    // arrives as `search`, which under the read rules would never meet the
    // allowlist at all.
    const policy = engine({ exec: { enabled: true, allow: ['ls'] } });
    const allowed = await policy.resolve({
      kind: 'tool',
      toolKind: 'search',
      title: 'List the workspace',
      locations: [],
      rawInput: { command: ['/bin/zsh', '-lc', 'ls'], cwd: root },
      ...where,
    });
    expect(allowed).toMatchObject({ verdict: 'allow', rule: 'exec.allow:ls' });

    const refused = await policy.resolve({
      kind: 'tool',
      toolKind: 'search',
      title: 'List the workspace',
      locations: [],
      rawInput: { command: ['/bin/zsh', '-lc', 'curl https://example.com'], cwd: root },
      ...where,
    });
    expect(refused).toMatchObject({ verdict: 'deny', rule: 'exec.otherwise' });
  });

  it('applies the workspace boundary to a codex edit through its locations', async () => {
    const policy = engine();
    const request = (file: string) => ({
      kind: 'tool' as const,
      toolKind: 'edit' as const,
      title: `Edit ${file}`,
      locations: [file],
      // codex names the file as a *key* under `changes`, where path extraction
      // never looks — `locations` is what actually carries it.
      rawInput: { changes: { [file]: { type: 'add', content: 'hello from codex.\n' } } },
      ...where,
    });
    expect((await policy.resolve(request(inside('NOTES.md')))).verdict).toBe('allow');
    expect((await policy.resolve(request('/etc/hosts'))).rule).toBe('tool.outside');
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

  it('takes the question down when the agent withdraws the request', async () => {
    // Otherwise the question sits there for its whole deadline and the answer
    // lands on a request that is no longer open.
    const withdrawn = new AbortController();
    const policy = engine({ decisionTimeoutMs: 60_000 }, { ask: () => new Promise(() => {}) });
    setTimeout(() => withdrawn.abort(), 10);
    const decision = await policy.resolve(
      { kind: 'tool', toolKind: 'other', title: 'Something unusual', locations: [], rawInput: null, ...where },
      { signal: withdrawn.signal },
    );
    expect(decision).toMatchObject({ verdict: 'deny', reason: 'no answer in time' });
  });

  it('says an agent is waiting for exactly as long as its question is open', async () => {
    let answer: (allowed: boolean) => void = () => {};
    const policy = engine({}, { ask: () => new Promise<boolean>((resolve) => (answer = resolve)) });
    expect(policy.isWaiting('claude')).toBe(false);

    const pending = policy.resolve({
      kind: 'tool',
      toolKind: 'other',
      title: 'Something unusual',
      locations: [],
      rawInput: null,
      ...where,
    });
    await Promise.resolve();
    expect(policy.isWaiting('claude')).toBe(true);
    // Another agent's turn keeps its own clocks running.
    expect(policy.isWaiting('gemini')).toBe(false);

    answer(true);
    await pending;
    expect(policy.isWaiting('claude')).toBe(false);
  });

  it('asks a question of its own only when a seat can take one', async () => {
    const fields = [{ key: 'why', label: 'Why?', kind: 'string' as const, required: true }];
    const alone = engine({}, { ask: async () => true });
    expect(await alone.elicit(where, { summary: 'which way?', fields })).toEqual({
      action: 'cancel',
    });

    const seated = engine(
      {},
      { ask: async () => true, input: async () => ({ action: 'accept', content: { why: 'a' } }) },
    );
    expect(await seated.elicit(where, { summary: 'which way?', fields })).toEqual({
      action: 'accept',
      content: { why: 'a' },
    });
  });

  it('cancels a question nobody answers in time', async () => {
    const policy = engine(
      { decisionTimeoutMs: 20 },
      { ask: async () => true, input: () => new Promise(() => {}) },
    );
    expect(
      await policy.elicit(where, {
        summary: 'which way?',
        fields: [{ key: 'why', label: 'Why?', kind: 'string', required: true }],
      }),
    ).toEqual({ action: 'cancel' });
  });

  it('records every decision, allowed or refused', async () => {
    const audit: AuditEntry[] = [];
    const policy = engine({}, undefined, audit);
    await policy.resolve({ kind: 'fs.read', path: inside('a.ts'), ...where });
    await policy.resolve({ kind: 'fs.write', path: '/etc/passwd', bytes: 3, ...where });
    expect(audit.map((entry) => entry.verdict)).toEqual(['allow', 'deny']);
    expect(audit[0]?.summary).toBe('read a.ts');
  });

  it('summarises a tool call without repeating the workspace path', async () => {
    const audit: AuditEntry[] = [];
    const policy = engine({}, undefined, audit);
    await policy.resolve({
      kind: 'tool',
      toolKind: 'edit',
      // Adapters put the absolute path in the title and again in `locations`.
      title: `Write ${inside('query.txt')}`,
      locations: [inside('query.txt')],
      rawInput: null,
      ...where,
    });
    expect(audit[0]?.summary).toBe('Write query.txt');
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

  it('reads the whole argv from a single array, as codex sends it', () => {
    expect(commandFromRawInput({ command: ['/bin/zsh', '-lc', 'ls'] })).toEqual({
      command: '/bin/zsh',
      args: ['-lc', 'ls'],
    });
  });

  it('gives up on input it does not understand', () => {
    expect(commandFromRawInput({ nothing: true })).toBeUndefined();
    expect(commandFromRawInput(null)).toBeUndefined();
    expect(commandFromRawInput({ command: [] })).toBeUndefined();
    // A half-string argv is not an argv we can vouch for.
    expect(commandFromRawInput({ command: ['sh', { nested: true }] })).toBeUndefined();
  });
});
