import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateElicitationResponse } from '@agentclientprotocol/sdk';
import type { PermissionMode } from '../src/policy/mode.js';
import type { Escalator, InputAnswer, InputField } from '../src/policy/types.js';
import { fakeAgent, type Act } from './fake-agent.js';
import { harness, type Harness } from './harness.js';

let open: Harness | undefined;

afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

/** A seat that answers after `delayMs`, so a test can hold a turn open. */
function seat(options: {
  allow?: boolean;
  delayMs?: number;
  input?: (fields: readonly InputField[], summary: string) => InputAnswer;
  onAsk?: (summary: string) => void;
}): Escalator {
  const escalator: Escalator = {
    ask: async (question) => {
      options.onAsk?.(question.summary);
      await pause(options.delayMs ?? 0);
      return options.allow ?? true;
    },
  };
  if (options.input) {
    const answer = options.input;
    escalator.input = async (question) => {
      await pause(options.delayMs ?? 0);
      return answer(question.fields, question.summary);
    };
  }
  return escalator;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTurn(
  script: (workspaceDir: string) => Act[],
  options: Omit<Parameters<typeof harness>[0], 'agents'> & { mode?: PermissionMode } = {},
) {
  let workspaceDir = '';
  const agent = fakeAgent({ script: () => script(workspaceDir) });
  const { mode, ...rest } = options;
  const h = harness({ agents: { claude: agent }, ...rest });
  open = h;
  workspaceDir = h.workspaceDir;
  // As `handsfree run --permission-mode` sets it: before any request is judged.
  if (mode) h.runtime.policy.setMode(mode);

  const session = await h.runtime.pool.session('claude');
  const { stopReason } = await session.prompt('go', {
    turnTimeoutMs: h.runtime.config.limits.turnTimeoutMs,
    idleTimeoutMs: h.runtime.config.limits.idleTimeoutMs,
    cancelGraceMs: h.runtime.config.limits.cancelGraceMs,
  });
  return { ...h, stopReason, agent };
}

describe('a turn that stops for a person', () => {
  it('does not run its clocks down while the question is on screen', async () => {
    // The agent goes quiet the moment it asks — a permission request is not a
    // session update — so an idle timer that cannot tell waiting from wedged
    // cancels the turn while the user is still reading the question.
    const answers: string[] = [];
    const { stopReason } = await runTurn(
      () => [
        {
          do: 'ask',
          title: 'Do something unusual',
          kind: 'other',
          onAnswer: (id) => answers.push(id),
        },
        { do: 'say', text: 'carried on' },
      ],
      {
        escalator: seat({ allow: true, delayMs: 400 }),
        config: { limits: { idleTimeoutMs: 150, turnTimeoutMs: 2_000 } },
      },
    );

    expect(answers).toEqual(['once']);
    expect(stopReason).toBe('end_turn');
  });

  it('still cancels a turn that goes quiet with nothing pending', async () => {
    const { stopReason } = await runTurn(() => [{ do: 'stall', ms: 5_000 }], {
      escalator: seat({ allow: true }),
      config: { limits: { idleTimeoutMs: 150, turnTimeoutMs: 5_000, cancelGraceMs: 500 } },
    });
    expect(stopReason).toBe('cancelled');
  });
});

describe('an agent that offers no single-use approval', () => {
  /** What claude-code-acp does when it will only take a standing approval. */
  const sessionWide = (dir: string, onAnswer: (id: string) => void): Act => ({
    do: 'ask',
    title: 'Edit notes.txt',
    kind: 'edit',
    locations: [path.join(dir, 'notes.txt')],
    options: [
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
    onAnswer,
  });

  it('asks the person before widening the approval, and takes a yes', async () => {
    const answers: string[] = [];
    const asked: string[] = [];
    await runTurn((dir) => [sessionWide(dir, (id) => answers.push(id))], {
      escalator: seat({ allow: true, onAsk: (summary) => asked.push(summary) }),
    });

    expect(asked).toHaveLength(1);
    expect(answers).toEqual(['always']);
  });

  it('cancels when the person says no', async () => {
    const answers: string[] = [];
    await runTurn((dir) => [sessionWide(dir, (id) => answers.push(id))], {
      escalator: seat({ allow: false }),
    });

    expect(answers).toEqual(['cancelled']);
  });

  it('cancels without asking when nobody is there', async () => {
    const answers: string[] = [];
    await runTurn((dir) => [sessionWide(dir, (id) => answers.push(id))]);

    expect(answers).toEqual(['cancelled']);
  });
});

describe('a turn under a permission mode', () => {
  const decisions = (h: Harness) =>
    h.runtime.transcript
      .all()
      .filter((record): record is Extract<typeof record, { type: 'decision' }> => record.type === 'decision')
      .map((record) => record.entry);

  it('answers a question itself in bypass, once, and writes down that the mode did', async () => {
    const answers: string[] = [];
    const h = await runTurn(
      () => [{ do: 'ask', title: 'Do something unusual', kind: 'other', onAnswer: (id) => answers.push(id) }],
      { mode: 'bypass' },
    );

    // No seat, and still a yes — the single-use one, never the standing one.
    expect(answers).toEqual(['once']);
    expect(decisions(h).at(-1)).toMatchObject({
      verdict: 'allow',
      rule: 'tool.unknownKind',
      mode: 'bypass',
    });
  });

  it('takes the standing approval in bypass without asking, and says so', async () => {
    const answers: string[] = [];
    const asked: string[] = [];
    const h = await runTurn(
      (dir) => [
        {
          do: 'ask',
          title: 'Edit notes.txt',
          kind: 'edit',
          locations: [path.join(dir, 'notes.txt')],
          options: [
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
          onAnswer: (id) => answers.push(id),
        },
      ],
      { mode: 'bypass', escalator: seat({ allow: false, onAsk: (summary) => asked.push(summary) }) },
    );

    expect(asked).toEqual([]);
    expect(answers).toEqual(['always']);
    expect(decisions(h).at(-1)).toMatchObject({ rule: 'tool.sessionWideOnly', mode: 'bypass' });
    const warned = h.runtime.transcript
      .all()
      .some((record) => record.type === 'note' && record.level === 'warn' && /whole session|rest of/.test(record.text));
    expect(warned).toBe(true);
  });

  it('lets an edit through in acceptEdits, and still asks about a command', async () => {
    const answers: string[] = [];
    const asked: string[] = [];
    const h = await runTurn(
      (dir) => [
        {
          do: 'ask',
          title: 'Edit notes.txt',
          kind: 'edit',
          locations: [path.join(dir, 'notes.txt')],
          onAnswer: (id) => answers.push(id),
        },
        {
          do: 'ask',
          title: 'git commit',
          kind: 'execute',
          rawInput: { command: 'git commit -m wip' },
          onAnswer: (id) => answers.push(id),
        },
      ],
      {
        mode: 'acceptEdits',
        config: { policy: { fs: { write: 'ask' } } },
        escalator: seat({ allow: true, onAsk: (summary) => asked.push(summary) }),
      },
    );

    expect(answers).toEqual(['once', 'once']);
    expect(asked).toEqual(['git commit']);
    expect(decisions(h).map((entry) => [entry.rule, entry.mode, entry.escalated])).toEqual([
      ['tool.write', 'acceptEdits', undefined],
      ['exec.otherwise', undefined, true],
    ]);
  });
});

describe('an agent that stops to ask a question', () => {
  const form = {
    type: 'object' as const,
    properties: {
      approach: {
        type: 'string' as const,
        title: 'Which approach?',
        enum: ['rewrite', 'patch'],
      },
      name: { type: 'string' as const, title: 'Name it' },
    },
    required: ['approach'],
  };

  it('puts the question to the person and hands back what they said', async () => {
    const answers: CreateElicitationResponse[] = [];
    const { runtime } = await runTurn(
      () => [
        {
          do: 'elicit',
          message: 'Rewrite the module or patch it?',
          schema: form,
          onAnswer: (response) => answers.push(response),
        },
      ],
      {
        escalator: seat({
          input: (fields) => {
            expect(fields.map((field) => field.kind)).toEqual(['enum', 'string']);
            expect(fields[0]?.required).toBe(true);
            expect(fields[0]?.options?.map((option) => option.value)).toEqual([
              'rewrite',
              'patch',
            ]);
            expect(fields[1]?.required).toBe(false);
            return { action: 'accept', content: { approach: 'patch', name: 'notes' } };
          },
        }),
      },
    );

    expect(answers).toEqual([{ action: 'accept', content: { approach: 'patch', name: 'notes' } }]);
    const notes = runtime.transcript
      .all()
      .filter((record) => record.type === 'note')
      .map((record) => record.text);
    expect(notes.some((text) => text.includes('Which approach? = patch'))).toBe(true);
  });

  it('cancels the question when there is no seat to put it in', async () => {
    const answers: CreateElicitationResponse[] = [];
    await runTurn(() => [
      {
        do: 'elicit',
        message: 'Rewrite the module or patch it?',
        schema: form,
        onAnswer: (response) => answers.push(response),
      },
    ]);

    expect(answers).toEqual([{ action: 'cancel' }]);
  });

  it('passes a refusal through as a refusal, not as silence', async () => {
    const answers: CreateElicitationResponse[] = [];
    await runTurn(
      () => [
        {
          do: 'elicit',
          message: 'Rewrite the module or patch it?',
          schema: form,
          onAnswer: (response) => answers.push(response),
        },
      ],
      { escalator: seat({ input: () => ({ action: 'decline' }) }) },
    );

    expect(answers).toEqual([{ action: 'decline' }]);
  });

  it('declines a mode handsfree never advertised', async () => {
    const answers: CreateElicitationResponse[] = [];
    await runTurn(
      () => [
        {
          do: 'elicit',
          mode: 'url',
          message: 'Log in here',
          onAnswer: (response) => answers.push(response),
        },
      ],
      { escalator: seat({ input: () => ({ action: 'accept', content: {} }) }) },
    );

    expect(answers).toEqual([{ action: 'decline' }]);
  });

  it('holds the turn open while the form is being filled in', async () => {
    const answers: CreateElicitationResponse[] = [];
    const { stopReason } = await runTurn(
      () => [
        {
          do: 'elicit',
          message: 'Rewrite the module or patch it?',
          schema: form,
          onAnswer: (response) => answers.push(response),
        },
        { do: 'say', text: 'patching' },
      ],
      {
        escalator: seat({
          delayMs: 400,
          input: () => ({ action: 'accept', content: { approach: 'patch' } }),
        }),
        config: { limits: { idleTimeoutMs: 150, turnTimeoutMs: 2_000 } },
      },
    );

    expect(answers).toEqual([{ action: 'accept', content: { approach: 'patch' } }]);
    expect(stopReason).toBe('end_turn');
  });

  it('is only offered where the capability is switched on', async () => {
    const on = await runTurn(() => [{ do: 'say', text: 'hi' }]);
    expect(on.agent.seen()?.elicitation).toEqual({ form: {} });
    await on.dispose();

    const off = await runTurn(() => [{ do: 'say', text: 'hi' }], {
      config: { capabilities: { elicitation: false } },
    });
    expect(off.agent.seen()?.elicitation).toBeUndefined();
  });
});
