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
  it.each([true, false])('forwards every request to the user and applies their answer (%s)', async (allow) => {
    const ask = vi.fn().mockResolvedValue(allow);
    const policy = engine({ exec: { enabled: false }, escalation: [] }, { ask });
    const requests: PolicyRequest[] = [
      { kind: 'fs.read', path: inside('a.ts'), ...where },
      { kind: 'fs.write', path: '/etc/hosts', bytes: 3, ...where },
      { kind: 'exec', command: 'git', args: ['diff'], cwd: root, ...where },
      { kind: 'tool', toolKind: 'read', title: 'Read the file', locations: [inside('a.ts')], rawInput: { path: inside('a.ts') }, ...where },
      { kind: 'tool', toolKind: 'execute', title: 'Show uncommitted change summary', locations: [], rawInput: { command: 'git diff' }, ...where },
      { kind: 'tool', toolKind: 'fetch', title: 'Fetch documentation', locations: [], rawInput: {}, ...where },
      { kind: 'tool', toolKind: 'switch_mode', title: 'Switch mode', locations: [], rawInput: {}, ...where },
    ];
    for (const request of requests) {
      expect(await policy.resolve(request)).toMatchObject({ verdict: allow ? 'allow' : 'deny', escalated: true });
    }
    expect(ask).toHaveBeenCalledTimes(requests.length);
    expect(ask.mock.calls[4]?.[0]).toMatchObject({
      summary: 'Show uncommitted change summary', detail: JSON.stringify({ command: 'git diff' }, null, 2),
    });
  });

  it('asks again for repeated calls after a one-time approval', async () => {
    const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const policy = engine({}, { ask });
    const request: PolicyRequest = { kind: 'fs.read', path: inside('a.ts'), ...where };
    expect((await policy.resolve(request)).verdict).toBe('allow');
    expect((await policy.resolve(request)).verdict).toBe('deny');
    expect(ask).toHaveBeenCalledTimes(2);
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
    const policy = engine({}, { ask: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) }, audit);
    await policy.resolve({ kind: 'fs.read', path: inside('a.ts'), ...where });
    await policy.resolve({ kind: 'fs.write', path: '/etc/passwd', bytes: 3, ...where });
    expect(audit.map((entry) => entry.verdict)).toEqual(['allow', 'deny']);
    expect(audit[0]?.summary).toBe('read a.ts');
  });

  it('preserves the tool title verbatim', async () => {
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
    expect(audit[0]?.summary).toBe(`Write ${inside('query.txt')}`);
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

describe('PolicyEngine under a permission mode', () => {
  const commit: PolicyRequest = {
    kind: 'exec',
    command: 'git',
    args: ['commit', '-m', 'wip'],
    cwd: undefined,
    ...where,
  };
  const outside: PolicyRequest = { kind: 'fs.write', path: '/etc/passwd', bytes: 1, ...where };
  const switchMode: PolicyRequest = {
    kind: 'tool',
    toolKind: 'switch_mode',
    title: 'switch_mode',
    locations: [],
    rawInput: null,
    ...where,
  };

  it('approves every request in bypass without an exception for tool kinds', async () => {
    const policy = engine({ exec: { enabled: false } });
    policy.setMode('bypass');

    expect(await policy.resolve(outside)).toMatchObject({
      verdict: 'allow',
      rule: 'fs.write.outside',
      mode: 'bypass',
    });
    expect(await policy.resolve(commit)).toMatchObject({
      verdict: 'allow',
      rule: 'exec.disabled',
      mode: 'bypass',
    });
    const refused = await policy.resolve(switchMode);
    expect(refused).toMatchObject({ verdict: 'allow', rule: 'tool.switchMode', mode: 'bypass' });
  });

  it('records bypass on every automatic approval', async () => {
    const audit: AuditEntry[] = [];
    const policy = engine({}, undefined, audit);
    policy.setMode('bypass');
    await policy.resolve({ kind: 'fs.read', path: inside('a.ts'), ...where });
    await policy.resolve(commit);
    expect(audit.map((entry) => [entry.rule, entry.mode])).toEqual([
      ['fs.read', 'bypass'],
      ['exec.otherwise', 'bypass'],
    ]);
  });

  it('takes the standing approval in bypass without asking', async () => {
    let asked = 0;
    const policy = engine({}, { ask: () => ((asked += 1), Promise.resolve(false)) });
    policy.setMode('bypass');
    const widened = await policy.confirm(commit, { rule: 'tool.sessionWideOnly', reason: 'whole session' });
    expect(widened).toMatchObject({ verdict: 'allow', rule: 'tool.sessionWideOnly', mode: 'bypass' });
    expect(widened.escalated).toBeUndefined();
    expect(asked).toBe(0);

    // In ask a standing approval is still a person's call.
    policy.setMode('ask');
    expect(await policy.confirm(commit, { rule: 'tool.sessionWideOnly', reason: 'whole session' })).toMatchObject({
      verdict: 'deny',
      escalated: true,
    });
    expect(asked).toBe(1);
  });

  it('marks a question answered by a mode switch as the mode’s, not a person’s', async () => {
    let policy!: PolicyEngine;
    const escalator: Escalator = {
      ask: async () => {
        // The seat flushes what it holds when the mode moves: a switch to
        // bypass while this question is up answers it.
        policy.setMode('bypass');
        return true;
      },
    };
    policy = engine({}, escalator);
    expect(await policy.resolve(commit)).toMatchObject({
      verdict: 'allow',
      rule: 'exec.otherwise',
      escalated: true,
      mode: 'bypass',
    });
    // A yes in ask mode is a person's, and carries no mode.
    const byHand = await engine({}, { ask: async () => true }).resolve(commit);
    expect(byHand).toMatchObject({ verdict: 'allow', escalated: true });
    expect(byHand.mode).toBeUndefined();
  });

  it('approves pending requests when switching to bypass without relying on the UI', async () => {
    const ask = vi.fn(() => new Promise<boolean>(() => {}));
    const policy = engine({}, { ask });
    const first = policy.resolve(commit);
    const second = policy.resolve(outside);
    expect(policy.isWaiting('claude')).toBe(true);
    policy.setMode('bypass');
    for (const result of await Promise.all([first, second])) {
      expect(result).toMatchObject({ verdict: 'allow', mode: 'bypass' });
    }
    expect(policy.isWaiting('claude')).toBe(false);
    policy.setMode('ask');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('leaves an agent’s own question alone in bypass', async () => {
    const policy = engine({});
    policy.setMode('bypass');
    expect(
      await policy.elicit(where, {
        summary: 'which way?',
        fields: [{ key: 'way', label: 'way', kind: 'string', required: true }],
      }),
    ).toEqual({ action: 'cancel' });
  });
});
