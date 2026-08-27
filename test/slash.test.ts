import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import type { TranscriptRecord } from '../src/workspace/transcript.js';

let open: Harness | undefined;
let root: string | undefined;

afterEach(async () => {
  await open?.dispose();
  open = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const answer = (message: string) => JSON.stringify({ action: 'answer', message });

/** A project directory holding the given command files. */
function project(files: Record<string, string>): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-slash-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, '.handsfree', 'commands', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function notes(h: Harness): Extract<TranscriptRecord, { type: 'note' }>[] {
  return h.runtime.transcript.all().filter((record) => record.type === 'note');
}

function decisions(h: Harness): Extract<TranscriptRecord, { type: 'decision' }>[] {
  return h.runtime.transcript.all().filter((record) => record.type === 'decision');
}

function userText(h: Harness): string[] {
  return h.runtime.transcript
    .all()
    .filter((record) => record.type === 'user')
    .map((record) => (record.type === 'user' ? record.text : ''));
}

/** The last thing the model was actually asked, across every call it saw. */
function lastPrompt(seen: { role: string; content: string }[][]): string {
  const messages = seen.at(-1) ?? [];
  return messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
}

describe('slash commands', () => {
  it('records the line that was typed and sends the expansion', async () => {
    const llm = scriptedModel([answer('done')]);
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm,
      cwd: project({ 'review.md': '---\ndescription: review a path\n---\nReview $ARGUMENTS closely.\n' }),
    });
    open = h;

    await h.runtime.conversation.send('/review src/policy');

    expect(userText(h)).toEqual(['/review src/policy']);
    expect(lastPrompt(llm.seen)).toBe('Review src/policy closely.');
  });

  it('answers a local command without waking the model', async () => {
    const llm = scriptedModel([]);
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    await h.runtime.conversation.send('/help');

    expect(llm.seen).toHaveLength(0);
    const [note] = notes(h);
    expect(note?.text).toBe('commands');
    expect(note?.lines?.join('\n')).toContain('/help');
  });

  // The one machine where /help matters most is the one with nothing set up.
  it('answers a local command with no agents configured at all', async () => {
    const llm = scriptedModel([]);
    const h = harness({ agents: {}, llm });
    open = h;

    await h.runtime.conversation.send('/config');

    expect(notes(h).at(-1)?.text).toBe('configuration');
    expect(h.runtime.transcript.all().some((record) => record.type === 'assistant')).toBe(false);
  });

  it('clears the conversation on /reset and says so', async () => {
    const llm = scriptedModel([answer('one')]);
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    await h.runtime.conversation.send('remember this');
    await h.runtime.conversation.send('/reset');

    expect(notes(h).at(-1)?.text).toContain('cleared');
    // The next turn starts from nothing: only the system prompt and the new ask.
    const after = scriptedModel([answer('two')]);
    (h.runtime.conversation as unknown as { deps: { llm: unknown } }).deps.llm = after;
    await h.runtime.conversation.send('and now this');
    expect((after.seen[0] ?? []).filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('refuses a command nobody defined instead of spending a turn on it', async () => {
    const llm = scriptedModel([]);
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    await h.runtime.conversation.send('/nope please');

    expect(llm.seen).toHaveLength(0);
    expect(notes(h).at(-1)).toMatchObject({ level: 'error' });
    expect(notes(h).at(-1)?.text).toContain('/nope');
  });

  // A path is not a command that went missing; it is text, and goes as text.
  it('sends a path-shaped line to the model unchanged', async () => {
    const llm = scriptedModel([answer('done')]);
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    await h.runtime.conversation.send('/usr/local/bin/thing is missing');

    expect(lastPrompt(llm.seen)).toBe('/usr/local/bin/thing is missing');
  });
});

describe('expansion through the policy engine', () => {
  const allowingEcho = { exec: { enabled: true, allow: ['echo'] } };

  it('runs an allowed command and puts its output in the prompt', async () => {
    const llm = scriptedModel([answer('done')]);
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm,
      config: { policy: allowingEcho },
      cwd: project({ 'facts.md': 'The state is:\n\n!`echo alive`\n' }),
    });
    open = h;

    await h.runtime.conversation.send('/facts');

    expect(lastPrompt(llm.seen)).toBe('The state is:\n\nalive');
    expect(decisions(h).at(-1)).toMatchObject({ agentId: '/facts', entry: { verdict: 'allow' } });
  });

  it('says a command was refused rather than working around it', async () => {
    const llm = scriptedModel([answer('done')]);
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm,
      config: { policy: allowingEcho },
      cwd: project({ 'push.md': 'Before: !`git push origin main`\n' }),
    });
    open = h;

    await h.runtime.conversation.send('/push');

    expect(lastPrompt(llm.seen)).toContain('[handsfree refused to run git push origin main');
    expect(decisions(h).at(-1)?.entry).toMatchObject({ verdict: 'deny', rule: 'exec.allowlist' });
  });

  it('refuses every command when running commands is switched off', async () => {
    const llm = scriptedModel([answer('done')]);
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm,
      config: { policy: { exec: { enabled: false } } },
      cwd: project({ 'facts.md': '!`echo alive`\n' }),
    });
    open = h;

    await h.runtime.conversation.send('/facts');

    expect(lastPrompt(llm.seen)).toContain('handsfree refused to run echo alive');
    expect(decisions(h).at(-1)?.entry).toMatchObject({ verdict: 'deny', rule: 'exec.disabled' });
  });

  it('reads a file inside the workspace, and records the read', async () => {
    const llm = scriptedModel([answer('done')]);
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm,
      cwd: project({ 'look.md': 'Here it is: @notes.txt\n' }),
    });
    open = h;
    fs.writeFileSync(path.join(h.workspaceDir, 'notes.txt'), 'the contents');

    await h.runtime.conversation.send('/look');

    expect(lastPrompt(llm.seen)).toContain('```notes.txt\nthe contents\n```');
    expect(decisions(h).at(-1)).toMatchObject({ agentId: '/look', entry: { verdict: 'allow' } });
  });

  // An address, a scoped package, a CSS rule: none of them asked to be read,
  // and refusing them would be worse than leaving the words where they are.
  it('leaves an @ that names no file alone, and asks nobody about it', async () => {
    const llm = scriptedModel([answer('done')]);
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm,
      cwd: project({ 'deps.md': 'Update @types/node and mail @someone.example.\n' }),
    });
    open = h;

    await h.runtime.conversation.send('/deps');

    expect(lastPrompt(llm.seen)).toBe('Update @types/node and mail @someone.example.');
    expect(decisions(h)).toHaveLength(0);
  });

  it('refuses a file outside the workspace', async () => {
    const llm = scriptedModel([answer('done')]);
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm,
      config: { policy: { fs: { outside: 'deny' } } },
      cwd: project({ 'peek.md': 'Read @../../../etc/hosts please.\n' }),
    });
    open = h;

    await h.runtime.conversation.send('/peek');

    // It resolves outside the jail, so it never becomes a read at all.
    expect(lastPrompt(llm.seen)).toContain('@../../../etc/hosts');
    expect(decisions(h)).toHaveLength(0);
  });
});
