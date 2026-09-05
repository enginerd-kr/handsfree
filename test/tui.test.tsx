import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableDebug, enableDebug } from '../src/debug.js';
import { App, menuFit } from '../src/ui/tui/app.js';
import { readClipboardImage } from '../src/ui/tui/clipboard.js';
import { DOT_BUSY, DOT_IDLE, PLAN_BUSY, PLAN_IDLE, PROMPT_CHAR } from '../src/ui/tui/theme.js';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import type { ChatClient } from '../src/models/client.js';

// A paste must never reach for the machine's real clipboard.
vi.mock('../src/ui/tui/clipboard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/tui/clipboard.js')>()),
  readClipboardImage: vi.fn(),
}));

let open: Harness | undefined;

afterEach(async () => {
  disableDebug();
  await open?.dispose();
  open = undefined;
});

/**
 * Waits for the rendered frame to contain `text`. Anchors must be short: ink
 * wraps long lines, so a path or a full sentence may never appear intact.
 */
async function waitFor(
  frame: () => string | undefined,
  text: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = frame() ?? '';
    if (current.includes(text)) return current;
    if (Date.now() > deadline) {
      throw new Error(`never rendered "${text}". Last frame:\n${current}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('terminal UI', () => {
  const appendTool = (h: Harness, id: string, text: string) => h.runtime.transcript.append({
    type: 'session_update', agentId: 'claude', sessionId: 's', update: {
      sessionUpdate: 'tool_call', toolCallId: id, title: `Run ${id}`, status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text } }],
    },
  });
  const pad = (n: number) => String(n).padStart(2, '0');

  it('prints a finished task folded, and prints it again open on ctrl+o', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    h.runtime.transcript.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'inspect tools' });
    h.runtime.transcript.append({ type: 'session_update', agentId: 'claude', sessionId: 's', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier message' },
    } });
    appendTool(h, 'first', 'first output');
    appendTool(h, 'second', 'second output');
    h.runtime.transcript.append({ type: 'session_update', agentId: 'claude', sessionId: 's', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'final answer' },
    } });
    h.runtime.transcript.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });
    const app = render(<App runtime={h.runtime} />);
    try {
      // Folded: the answer and the closing line, with the way back on the latter.
      let frame = await waitFor(() => app.lastFrame(), 'Done (2 tool calls · 1s · ctrl+o to expand');
      expect(frame).toContain('final answer');
      expect(frame).not.toContain('earlier message');
      expect(frame).not.toContain('Run first');
      // ctrl+o prints the whole transcript again with everything open — the
      // rows already in the scrollback cannot be redrawn where they stand.
      app.stdin.write('\x0f');
      frame = await waitFor(() => app.lastFrame(), 'earlier message');
      expect(frame).toContain('Run first');
      expect(frame).toContain('first output');
      expect(frame).toContain('second output');
      expect(frame).toContain('ctrl+o to collapse');
      // And again, everything folded — and each row once, however many times
      // the transcript has been printed.
      app.stdin.write('\x0f');
      frame = await waitFor(() => app.lastFrame(), 'ctrl+o to expand');
      expect(frame).not.toContain('earlier message');
      expect(frame.split('final answer')).toHaveLength(2);
      expect(frame.split('handsfree v')).toHaveLength(2);
    } finally {
      app.unmount();
    }
  });

  it('folds a tool result once it completes, and ctrl+o opens it', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    appendTool(h, 'finish', 'streaming output');
    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), 'streaming output');
      h.runtime.transcript.append({ type: 'session_update', agentId: 'claude', sessionId: 's', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'finish', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'final output\nlast detail' } }],
      } });
      const folded = await waitFor(() => app.lastFrame(), '… +2 lines');
      expect(folded).not.toContain('final output');
      expect(folded).not.toContain('streaming output');
      app.stdin.write('\x0f');
      const expanded = await waitFor(() => app.lastFrame(), 'final output');
      expect(expanded).toContain('last detail');
    } finally {
      app.unmount();
    }
  });

  it('caps a running result at its head, and ctrl+o gives the rest back', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    appendTool(h, 'long', Array.from({ length: 20 }, (_, n) => `output-${n + 1}`).join('\n'));
    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), '… +8 lines');
      app.stdin.write('\x0f');
      await waitFor(() => app.lastFrame(), 'output-20');
      app.stdin.write('\x0f');
      const frame = await waitFor(() => app.lastFrame(), '… +20 lines');
      expect(frame).not.toContain('output-');
      expect(frame).toContain('Run long');
    } finally {
      app.unmount();
    }
  });

  it('expands and collapses every task, the ones already in the scrollback included', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    for (let taskId = 1; taskId <= 12; taskId++) {
      h.runtime.transcript.append({ type: 'delegation', taskId, agentId: 'claude', sessionId: 's', task: `brief-${taskId}` });
      appendTool(h, `command-${taskId}`, `result-${taskId}`);
      h.runtime.transcript.append({ type: 'stop', taskId, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });
    }
    const app = render(<App runtime={h.runtime} />);
    try {
      const folded = await waitFor(() => app.lastFrame(), 'Done');
      expect(folded).not.toContain('brief-');
      app.stdin.write('\x0f');
      const opened = await waitFor(() => app.lastFrame(), 'result-12');
      expect(opened).toContain('brief-1');
      expect(opened).toContain('result-1');
      app.stdin.write('\x0f');
      await waitFor(() => app.lastFrame(), 'ctrl+o to expand');
      expect(app.lastFrame()).not.toContain('result-');
      expect(app.lastFrame()).not.toContain('brief-');
    } finally {
      app.unmount();
    }
  });

  it('says under the prompt where debug lines go, only while debug is on', async () => {
    enableDebug(() => {}, '/tmp/hf-debug.log');
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      // Anchored on the tail: the marker is drawn `truncate-start`, so on a
      // narrow frame it is the path that survives and the words that go.
      const frame = await waitFor(() => app.lastFrame(), '/tmp/hf-debug.log');
      expect(frame).toContain('debug');
    } finally {
      app.unmount();
    }
  });

  it('keeps the debug marker off screen when debug is off', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      const frame = await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      expect(frame).not.toContain('● debug');
    } finally {
      app.unmount();
    }
  });

  it('fills an agent’s dot under the prompt while it holds a task', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      // Idle: the roll call names the agent behind an outlined dot.
      await waitFor(() => app.lastFrame(), `${DOT_IDLE} claude`);

      h.runtime.transcript.append({
        type: 'delegation',
        taskId: 1,
        agentId: 'claude',
        sessionId: 's',
        task: 'dig',
      });
      const busy = await waitFor(() => app.lastFrame(), 'dig');
      expect(busy).toContain(`${DOT_BUSY} claude`);
      expect(busy).not.toContain(`${DOT_IDLE} claude`);

      h.runtime.transcript.append({
        type: 'stop',
        taskId: 1,
        agentId: 'claude',
        sessionId: 's',
        stopReason: 'end_turn',
      });
      await waitFor(() => app.lastFrame(), `${DOT_IDLE} claude`);
    } finally {
      app.unmount();
    }
  });

  it('opens the roll with the planner: the agent it routes through, and on what', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      config: { orchestration: { provider: 'acp', acp: { agent: 'claude', model: 'haiku' } } },
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      // Spelled the way the mention that moves it is, and marked with a
      // diamond: it is the only entry on the line that is not an agent.
      const frame = await waitFor(() => app.lastFrame(), `${PLAN_IDLE} claude:haiku`);
      // The agent it plans through still stands in the roll on its own — that
      // is a different session, doing different work.
      expect(frame).toContain(`${DOT_IDLE} claude`);
    } finally {
      app.unmount();
    }
  });

  it('fills the planner’s diamond while it is the one working', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm: ChatClient = {
      async chat() {
        await held;
        return JSON.stringify({ action: 'answer', message: 'an answer.' });
      },
    };
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      // A local endpoint has no agent to name, so the model stands alone.
      await waitFor(() => app.lastFrame(), `${PLAN_IDLE} google/gemma-3-12b`);

      app.stdin.write('go\r');
      const working = await waitFor(() => app.lastFrame(), `${PLAN_BUSY} google/gemma-3-12b`);
      // The agent is not working: nothing has been delegated to it.
      expect(working).toContain(`${DOT_IDLE} claude`);
    } finally {
      release();
      app.unmount();
    }
  });

  it('greets on the opening frame, in lines that can be sent as they stand', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ models: ['opus', 'haiku'], script: () => [] }) },
      llm: scriptedModel([JSON.stringify({ action: 'answer', message: 'Hello there.' })]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      const frame = await waitFor(() => app.lastFrame(), 'Hello.');
      // A window with room for all of it gets all of it: what handsfree does
      // with a line, and every shape a line can take.
      expect(frame).toContain('as you would say it');
      expect(frame).toContain('Try a line like one of these.');
      expect(frame).toContain('/agents');
      // The planner by the name a mention gives it, and the agent on a model
      // off its own roster — not a fixed cast written into the greeting.
      expect(frame).toContain('@orchestrator');
      await waitFor(() => app.lastFrame(), '@claude:opus');

      // The first line sent goes under it, and the greeting stays where it
      // stood — printed with the header, the way a conversation opens.
      await h.runtime.conversation.send('hi');
      const after = await waitFor(() => app.lastFrame(), 'Hello there.');
      expect(after.indexOf('What are we working on today?')).toBeGreaterThan(-1);
      expect(after.indexOf('What are we working on today?')).toBeLessThan(after.indexOf('Hello there.'));
    } finally {
      app.unmount();
    }
  });

  it('renders the transcript as it arrives', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([JSON.stringify({ action: 'answer', message: 'Hello there.' })]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('hi');
      const frame = await waitFor(() => app.lastFrame(), 'Hello there.');
      // The user's line opens on a hollow dot rather than a `>`, so its text
      // starts in the column the reply's does.
      const lines = frame.split('\n');
      const asked = lines.find((line) => line.includes('○ hi'));
      const answered = lines.find((line) => line.includes('Hello there.'));
      expect(asked).toContain('○ hi');
      expect(asked?.indexOf('hi')).toBe(answered?.indexOf('Hello there.'));
    } finally {
      app.unmount();
    }
  });

  it('folds a finished task, and gives it back on ctrl+o', async () => {
    const h = harness({
      agents: {
        claude: fakeAgent({ script: () => [{ do: 'say', text: 'the long agent answer' }] }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', kind: 'answer', prompt: 'who?' } }),
        JSON.stringify({ action: 'answer', message: 'claude answered.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('who are you');
      await waitFor(() => app.lastFrame(), 'claude answered.');

      // Folded: the answer stays, and the planner's brief is off screen.
      expect(app.lastFrame()).toContain('ctrl+o');
      expect(app.lastFrame()).toContain('the long agent answer');
      expect(app.lastFrame()).not.toContain('who?');

      app.stdin.write('\x0f'); // ctrl+o
      await waitFor(() => app.lastFrame(), 'who?');
    } finally {
      app.unmount();
    }
  });

  it('reads an @mentioned turn as a conversation: no routing row, the answer kept, no REPORT', async () => {
    const h = harness({
      agents: {
        claude: fakeAgent({
          script: () => [{ do: 'say', text: 'I am claude.\n\nREPORT\noutcome: done\nsummary: said who' }],
        }),
      },
      // The planner is never asked: a reply scripted here would run dry.
      llm: scriptedModel([]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('@claude who are you');
      const frame = await waitFor(() => app.lastFrame(), 'Done');
      // The line typed is on screen once, and the agent's own words follow it
      // in the agent's name — no row saying the line again, no ledger over
      // the answer, and nothing of the block meant for the planner.
      expect(frame.split('who are you')).toHaveLength(2);
      expect(frame).toContain('claude  I am claude.');
      expect(frame).not.toContain('REPORT');
      expect(frame).not.toContain('task 1');
    } finally {
      app.unmount();
    }
  });

  it('starts a code block beside the agent\'s name, keeping its lines aligned', async () => {
    const h = harness({
      agents: {
        claude: fakeAgent({
          script: () => [{ do: 'say', text: '```js\nfunction greet(name) {\n  return name;\n}\n```' }],
        }),
      },
      llm: scriptedModel([]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('@claude show me');
      const frame = await waitFor(() => app.lastFrame(), 'Done');
      const lines = frame.split('\n');
      const name = lines.findIndex((line) => line.includes('claude  function'));
      expect(name).toBeGreaterThan(-1);
      // The block's lines share a column, the first no further right than the rest.
      expect(lines[name]?.indexOf('function')).toBe(lines[name + 2]?.indexOf('}'));
    } finally {
      app.unmount();
    }
  });

  it('edits at the cursor: arrows, home, end, both deletes', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    // The cursor is drawn by inverting a character, which splits the plain
    // text with styling codes; matching needs the bare characters back.
    const plain = () => (app.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'hllo');
      await press('[D', '[D', '[D'); // left ×3, onto the first l
      await press('e');
      await waitFor(plain, `${PROMPT_CHAR} hello`);

      await press('\x01', '[3~'); // ctrl+a, then forward delete eats the h
      await waitFor(plain, `${PROMPT_CHAR} ello`);

      await press('\x05', '\x7f'); // ctrl+e, then backspace eats the o
      await waitFor(plain, `${PROMPT_CHAR} ell`);
      // On the draft line, that is: the greeting above it says hello too.
      expect(plain()).not.toContain(`${PROMPT_CHAR} ello`);
    } finally {
      app.unmount();
    }
  });

  it('breaks the line on shift+enter or option+enter, and sends every line on enter', async () => {
    const llm = scriptedModel([JSON.stringify({ action: 'answer', message: 'got it.' })]);
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const plain = () => (app.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      // The terminal's answer to the kitty query reaches the prompt as well
      // as Ink, and must not be typed.
      await press('\u001B[?0u');
      await press(...'one');
      await waitFor(plain, `${PROMPT_CHAR} one`);
      expect(plain()).not.toContain('?0u');
      await press('\u001B[13;2u'); // shift+enter, as the kitty protocol encodes it
      await press(...'two');
      await press('\u001B\r'); // option+enter, in the legacy encoding
      await press(...'three');
      // Three lines in the prompt, nothing sent: the model has not been asked.
      await waitFor(plain, `${PROMPT_CHAR} one`);
      expect(plain()).toContain('\n  two');
      expect(plain()).toContain('\n  three');
      expect(llm.seen).toHaveLength(0);

      // Up walks the lines before it reaches the history: home on the middle
      // line, then a character typed there, lands on that line alone.
      await press('\u001B[A', '\x01', '-');
      await waitFor(plain, '\n  -two');

      await press('\r');
      await waitFor(() => app.lastFrame(), 'got it.');
      expect(llm.seen[0]?.some((message) => message.content.endsWith('\n---\none\n-two\nthree'))).toBe(true);
      // Sent, the prompt is empty and back to one line — the lines above it
      // now are the transcript's copy of what went.
      const promptAt = plain().split('\n').findIndex((line) => line.includes(PROMPT_CHAR));
      expect(plain().split('\n')[promptAt]?.trim()).toBe(PROMPT_CHAR);
      expect(plain().split('\n')[promptAt + 1]?.trim()).toMatch(/^─+$/);
    } finally {
      app.unmount();
    }
  });

  it('folds a long paste and an image to placeholders, and unfolds them in what is sent', async () => {
    const llm = scriptedModel([JSON.stringify({ action: 'answer', message: 'seen.' })]);
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-paste-'));
    const picture = path.join(dir, 'shot one.png');
    fs.writeFileSync(picture, 'not really a png');
    const fromClipboard = path.join(dir, 'clipboard.png');
    vi.mocked(readClipboardImage).mockResolvedValue(fromClipboard);

    const app = render(<App runtime={h.runtime} />);
    const plain = () => (app.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const paste = (text: string) => press(`\u001B[200~${text}\u001B[201~`);
    const pages = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'see ');
      await paste(pages);
      await waitFor(plain, `${PROMPT_CHAR} see [Pasted text #1 +4 lines]`);
      expect(plain()).not.toContain('gamma');

      // A short paste is typed as it is, line break and all.
      await paste(' and\nthen ');
      // The frame is drawn without its trailing space.
      await waitFor(plain, '\n  then');

      // A file's path, dragged in with its space escaped, is the image it names.
      await paste(picture.replace(/ /g, '\\ '));
      await waitFor(plain, 'then [Image #1]');
      // Ctrl+v asks the clipboard, and attaches what it had.
      await press('\x16');
      await waitFor(plain, '[Image #1][Image #2]');
      expect(vi.mocked(readClipboardImage).mock.calls[0]?.[0]).toBe(
        path.join(h.runtime.workspace.dir, '.handsfree', 'images'),
      );

      // Backspace takes the last placeholder whole, not a bracket off it.
      await press('\x7f');
      await waitFor(plain, 'then [Image #1]\n');
      expect(plain()).not.toContain('[Image #2');

      await press('\r');
      await waitFor(() => app.lastFrame(), 'seen.');
      const sent = `see ${pages} and\nthen [Image #1: ${picture}]`;
      expect(llm.seen[0]?.some((message) => message.content.endsWith(`\n---\n${sent}`))).toBe(true);
      // The transcript shows the line as it was seen, folded.
      expect(plain()).toContain('see [Pasted text #1 +4 lines] and');
      expect(plain()).not.toContain('gamma');
    } finally {
      app.unmount();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks back through what was sent with the arrows, and forward to the draft', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([
        JSON.stringify({ action: 'answer', message: 'one.' }),
        JSON.stringify({ action: 'answer', message: 'two.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    // The prompt's own line, without the styling the cursor is drawn with:
    // what was sent is also up in the transcript, so the whole frame cannot
    // say which line the arrows put where.
    const prompt = () =>
      (app.lastFrame() ?? '')
        .replace(/\u001B\[[0-9;]*m/g, '')
        .split('\n')
        .find((line) => line.includes(PROMPT_CHAR)) ?? '';
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'first', '\r');
      await waitFor(() => app.lastFrame(), 'one.');
      await press(...'second', '\r');
      await waitFor(() => app.lastFrame(), 'two.');
      await press(...'half');

      await press('\u001B[A'); // up: the line sent last
      expect(prompt()).toContain('second');
      await press('\u001B[A'); // up: the one before it
      expect(prompt()).toContain('first');
      await press('\u001B[A'); // nowhere further back to go
      expect(prompt()).toContain('first');

      await press('\u001B[B'); // down, and back to what was half-written
      expect(prompt()).toContain('second');
      await press('\u001B[B');
      expect(prompt()).toContain('half');
      expect(prompt()).not.toContain('second');
    } finally {
      app.unmount();
    }
  });

  it('starts the walk afresh once a recalled line is edited', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([JSON.stringify({ action: 'answer', message: 'one.' })]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const prompt = () =>
      (app.lastFrame() ?? '')
        .replace(/\u001B\[[0-9;]*m/g, '')
        .split('\n')
        .find((line) => line.includes(PROMPT_CHAR)) ?? '';
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'first', '\r');
      await waitFor(() => app.lastFrame(), 'one.');

      await press('\u001B[A'); // up: `first` is recalled
      expect(prompt()).toContain('first');
      await press(...' again'); // edited, so it is a draft of its own now
      expect(prompt()).toContain('first again');
      await press('\u001B[B'); // down has nothing to hand back
      expect(prompt()).toContain('first again');
      await press('\u001B[A'); // and up starts over from the newest line
      expect(prompt()).toContain('first');
      expect(prompt()).not.toContain('again');
    } finally {
      app.unmount();
    }
  });

  it('treats /exit as leaving, not as a prompt for the model', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      for (const char of '/exit') {
        app.stdin.write(char);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await waitFor(() => app.lastFrame(), '/exit');
      app.stdin.write('\r');
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Leaving means the conversation never hears about it.
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(0);
      expect(app.lastFrame()).not.toContain('Working');
    } finally {
      app.unmount();
    }
  });

  it('offers the commands a half-written line could still become', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);

      app.stdin.write('/');
      await waitFor(() => app.lastFrame(), '/clear');
      expect(app.lastFrame()).toContain('/help');

      // The live part of the screen has to fit the window — the test renderer
      // has no rows, and the UI assumes thirty — so the rows the menu takes
      // come out of the greeting above it, never out of the window.
      expect((app.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(29);
    } finally {
      app.unmount();
    }
  });

  it('shows planning work and allows Esc when a plan command starts a turn', async () => {
    const llm: ChatClient = { async chat(_messages, options) {
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('cancelled');
    } };
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;
    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      app.stdin.write('/plan Inspect the loop');
      await new Promise((resolve) => setTimeout(resolve, 30));
      app.stdin.write('\r');
      await waitFor(() => app.lastFrame(), 'Working…');
      await waitFor(() => app.lastFrame(), 'plan mode');
      app.stdin.write('\x1b');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(h.runtime.conversation.isBusy).toBe(false);
      expect(app.lastFrame()).not.toContain('Working…');
    } finally { h.runtime.conversation.cancel(); app.unmount(); }
  });

  it('moves the highlight with the arrows and sends the one it lands on', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      // The bare slash offers everything, shortest name first and then by
      // name: cost, exit, help, plan, clear. Four steps down lands on clear.
      await press('/');
      await waitFor(() => app.lastFrame(), '/clear');
      await press('\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r');

      await waitFor(() => app.lastFrame(), 'cleared');
      expect(app.lastFrame()).not.toContain('Working');
    } finally {
      app.unmount();
    }
  });

  it('completes on tab and sends on enter', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const plain = () => (app.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'/hel');
      await waitFor(() => app.lastFrame(), '/help');

      // Tab fills the line in and leaves it there; it is not a submission.
      await press('\t');
      await waitFor(plain, `${PROMPT_CHAR} /help`);
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(0);

      await press('\r');
      await waitFor(() => app.lastFrame(), 'what you can type');
      expect(app.lastFrame()).not.toContain('Working');
    } finally {
      app.unmount();
    }
  });

  it('offers the agents a half-written mention could still become', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }), gemini: fakeAgent({ script: () => [] }) },
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);

      app.stdin.write('@');
      const frame = await waitFor(() => app.lastFrame(), '@gemini');
      expect(frame).toContain('@claude');

      // Same rule as the command menu: the rows come out of what is above,
      // never out of the window.
      expect((app.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(29);
    } finally {
      app.unmount();
    }
  });

  it('keeps the agent menu shut mid-word, where an @ is an address', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }), gemini: fakeAgent({ script: () => [] }) },
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      for (const char of 'me@g') {
        app.stdin.write(char);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await waitFor(() => app.lastFrame(), 'me@g');
      // A menu row is a name at the head of its own line; the greeting's
      // examples spell names too, and they sit inside quotation marks.
      expect(app.lastFrame()).not.toMatch(/^\s*@gemini/m);
    } finally {
      app.unmount();
    }
  });

  it('fills a mention in on tab or enter, and never sends it', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }), gemini: fakeAgent({ script: () => [] }) },
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const plain = () => (app.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'@ge');
      await waitFor(() => app.lastFrame(), '@gemini');

      // Enter completes the name rather than sending it: the mention opens a
      // task, and the task is still to be written.
      await press('\r');
      await waitFor(plain, `${PROMPT_CHAR} @gemini`);
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(0);
      expect(plain()).not.toContain('@ge ');
    } finally {
      app.unmount();
    }
  });

  it('browses directories from @ and selects files beyond the first menu page without sending', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    fs.mkdirSync(path.join(h.runtime.workspace.dir, 'source files'));
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(h.runtime.workspace.dir, 'source files', `file${pad(i)}.ts`), '');
    }
    const app = render(<App runtime={h.runtime} />);
    const plain = () => (app.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
    const press = async (key: string) => {
      app.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    try {
      await waitFor(plain, PROMPT_CHAR);
      await press('@');
      await waitFor(plain, '@./source files/');
      await press('\u001B[B');
      await press('\u001B[B');
      await press('\t');
      await waitFor(plain, '@./source files/file00.ts');
      for (let i = 0; i < 19; i++) await press('\u001B[B');
      await waitFor(plain, '@./source files/file19.ts');
      expect(plain().split('\n').length).toBeLessThanOrEqual(29);
      await press('\r');
      await waitFor(plain, `${PROMPT_CHAR} @"./source files/file19.ts"`);
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(0);
    } finally {
      app.unmount();
    }
  });

  it('wakes every agent at launch, so the roster is already in hand', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ models: ['opus[1m]', 'sonnet'], script: () => [] }) },
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      // Nothing has been typed and nothing delegated, yet the roll call
      // already names the model the session came up on — the session is open.
      await waitFor(() => app.lastFrame(), `${DOT_IDLE} opus[1m]`);
      expect(h.runtime.pool.isOpen('claude')).toBe(true);
    } finally {
      app.unmount();
    }
  });

  it('keeps the spend by model on a line of its own above the roll call', async () => {
    const h = harness({
      agents: {
        claude: fakeAgent({ models: ['opus', 'haiku'], script: () => [] }),
        gemini: fakeAgent({ script: () => [] }),
      },
      llm: scriptedModel([]),
    });
    open = h;
    const { transcript } = h.runtime;
    // A planning call the endpoint counted, and one it did not.
    transcript.append({ type: 'usage', purpose: 'plan', model: 'google/gemma-3-12b', promptChars: 4_000, replyChars: 400, promptTokens: 900, completionTokens: 100 });
    transcript.append({ type: 'usage', purpose: 'plan', model: 'google/gemma-3-12b', promptChars: 4_000, replyChars: 400 });
    // Two tasks of claude's, on two models: the session was moved between them.
    for (const [taskId, model, tokens] of [[1, 'opus', 12_300], [2, 'haiku', 1_500]] as const) {
      transcript.append({ type: 'delegation', taskId, agentId: 'claude', sessionId: 's', task: 'go' });
      transcript.append({
        type: 'stop',
        taskId,
        agentId: 'claude',
        sessionId: 's',
        stopReason: 'end_turn',
        usage: { inputTokens: tokens - 300, outputTokens: 300, totalTokens: tokens },
        model,
      });
    }

    const app = render(<App runtime={h.runtime} />);
    try {
      // Each model at what it earned, in the order they were first used; the
      // planner's figure is part measured, so it wears the estimate's mark.
      const frame = await waitFor(() => app.lastFrame(), 'google/gemma-3-12b ≈2.1k · opus 12k · haiku 1.5k');
      // The roll call stays names and dots: the model it shows is the one
      // claude is on now, which is not the one most of the spend went to.
      expect(frame).toContain(`${PLAN_IDLE} google/gemma-3-12b · ${DOT_IDLE} opus · ${DOT_IDLE} gemini`);
      // And the header roster stays names only, up to the box's edge.
      expect(frame).toMatch(/google\/gemma-3-12b · claude, gemini\s*│/);
    } finally {
      app.unmount();
    }
  });

  it('gives the spend line no row until something has been spent', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm: scriptedModel([]) });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      const frame = await waitFor(() => app.lastFrame(), `${DOT_IDLE} claude`);
      const lines = frame.split('\n');
      const roll = lines.findIndex((line) => line.includes(`${DOT_IDLE} claude`));
      // The rows above the roll call carry nothing but the mark, at the right
      // edge: no spend line yet, and nothing to the mark's left.
      const beside = (line: string | undefined) => {
        const at = line?.search(/[▐▝▗▘▛▜█]/) ?? -1;
        expect(at).toBeGreaterThan(0);
        return line?.slice(0, at).trim();
      };
      expect(beside(lines[roll - 1])).toBe('');
      expect(beside(lines[roll - 2])).toBe('');
      // The roll call is the sixth row from the bottom: the two rules with the
      // input between them, the hints, and the permission mode under those.
      expect(lines.length - roll).toBe(6);
    } finally {
      app.unmount();
    }
  });

  it('holds a whole roster at once, however long it is', async () => {
    // The roster gemini actually advertises, to the row: a list cut short is
    // one you cannot be sure you have read.
    const models = [
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview-customtools',
      'auto',
    ];
    const h = harness({ agents: { gemini: fakeAgent({ models, script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      for (const key of '@gemini:') {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const listed = await waitFor(() => app.lastFrame(), ':auto');
      for (const model of models) expect(listed).toContain(`:${model}`);
      // In the agent's own order, first to last.
      const at = models.map((model) => listed.indexOf(`:${model}`));
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    } finally {
      app.unmount();
    }
  });

  it('spares a model roster the crowding limit the other menus keep to', () => {
    // A twenty-four row terminal — the short window that used to cut a
    // six-model roster to five rows, losing the last one. With the header
    // printed and gone, the roster has the room; while the header is still
    // up it is the greeting under it that gives way, not the roster.
    expect(menuFit('model', 24, 0)).toBeGreaterThanOrEqual(6);
    expect(menuFit('model', 24, 6)).toBe(4);
    // A slash still yields to the transcript at the same height, because its
    // list narrows as the name is typed and a cut there loses nothing.
    expect(menuFit('command', 24, 0)).toBe(6);
    // Shorter still, and the menu goes rather than the frame overflowing.
    expect(menuFit('model', 14, 6)).toBe(0);
  });

  it('says why a colon has nothing to offer, rather than showing nothing', async () => {
    // An adapter that advertises no models at all: its `session/new` answers
    // with a session id and nothing else.
    const h = harness({
      agents: { gemini: fakeAgent({ script: () => [] }) },
      config: { profiles: { gemini: { model: undefined } } },
      llm: scriptedModel([JSON.stringify({ action: 'answer', message: 'that is not a model.' })]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), `${DOT_IDLE} gemini`);
      await press(...'@gemini:');

      const frame = await waitFor(() => app.lastFrame(), 'offers no model selection');
      expect(frame).toContain('gemini');

      // The line is drawn, not offered: enter still sends rather than being
      // eaten by a menu that has nothing in it.
      await press('\r');
      await waitFor(() => app.lastFrame(), '@gemini:');
      expect(h.runtime.transcript.all().some((r) => r.type === 'user')).toBe(true);
    } finally {
      app.unmount();
    }
  });

  it('offers the models a colon could pick, and fills the address in', async () => {
    const h = harness({
      agents: {
        gemini: fakeAgent({ models: ['gemini-3.5-flash', 'gemini-3.5-pro'], script: () => [] }),
      },
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const plain = () => (app.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'@ge');
      await waitFor(() => app.lastFrame(), '@gemini');

      // Completing the name adds no space and leaves the menu shut, so the
      // colon lands right against it and opens the model list instead.
      await press('\r');
      await waitFor(plain, `${PROMPT_CHAR} @gemini`);
      expect(plain()).not.toContain(`${PROMPT_CHAR} @gemini `);

      await press(':');
      // The rows are what the session advertised when it was warmed at launch,
      // in the order it advertised them.
      const listed = await waitFor(() => app.lastFrame(), ':gemini-3.5-pro');
      expect(listed).toContain(':gemini-3.5-flash');
      expect(listed.indexOf(':gemini-3.5-flash')).toBeLessThan(listed.indexOf(':gemini-3.5-pro'));

      // Tab fills the whole address in and closes it with a space; nothing is sent.
      await press('\t');
      await waitFor(plain, `${PROMPT_CHAR} @gemini:gemini-3.5-flash`);
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(0);
    } finally {
      app.unmount();
    }
  });

  it('walks the planner’s address: the agent behind the colon, then its model', async () => {
    const h = harness({
      agents: {
        gemini: fakeAgent({ models: ['gemini-3.5-flash', 'gemini-3.5-pro'], script: () => [] }),
      },
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const plain = () => (app.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);

      // The planner stands in the roster an at-sign opens, beside the agents.
      await press(...'@orch');
      await waitFor(() => app.lastFrame(), '@orchestrator');
      await press('\r');
      await waitFor(plain, `${PROMPT_CHAR} @orchestrator`);

      // Behind its colon the rows are agents, offered as the `:segment` of the
      // address they are being typed into rather than as `@` names of their own.
      await press(':');
      await waitFor(() => app.lastFrame(), ':gemini');
      await press('\r');
      await waitFor(plain, `${PROMPT_CHAR} @orchestrator:gemini`);

      // And behind the next colon they are that agent's models again.
      await press(':');
      await waitFor(() => app.lastFrame(), ':gemini-3.5-pro');
      await press('\t');
      await waitFor(plain, `${PROMPT_CHAR} @orchestrator:gemini:gemini-3.5-flash`);
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(0);
    } finally {
      app.unmount();
    }
  });

  it('closes the menu on escape without stopping the turn behind it', async () => {
    let release: (() => void) | undefined;
    let turn = 0;
    const llm: ChatClient = {
      async chat(_messages, options) {
        if (turn++ === 0) {
          // Held until the test lets go, or until the turn is cancelled —
          // which is the thing being tested, so it has to be felt here.
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            });
          });
        }
        return JSON.stringify({ action: 'answer', message: 'an answer.' });
      },
    };
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'go', '\r');
      await waitFor(() => app.lastFrame(), 'Working…');

      await press('/');
      await waitFor(() => app.lastFrame(), '/clear');
      await press('\x1b');
      await waitFor(() => app.lastFrame(), 'Working…');
      expect(app.lastFrame()).not.toContain('/clear');

      // The first escape was spent on the menu; the second reaches the turn.
      await press('\x1b');
      const deadline = Date.now() + 2_000;
      while ((app.lastFrame() ?? '').includes('Working…')) {
        if (Date.now() > deadline) throw new Error(`the turn never stopped:\n${app.lastFrame()}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(app.lastFrame()).not.toContain('an answer.');
    } finally {
      release?.();
      app.unmount();
    }
  });

  it('answers a command mid-turn instead of queueing it behind one', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let turn = 0;
    const llm: ChatClient = {
      async chat() {
        if (turn++ === 0) await held;
        return JSON.stringify({ action: 'answer', message: 'an answer.' });
      },
    };
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await press(...'go', '\r');
      await waitFor(() => app.lastFrame(), 'Working…');

      await press(...'/help', '\r');
      await waitFor(() => app.lastFrame(), 'what you can type');
      expect(app.lastFrame()).not.toContain('queued');
    } finally {
      release();
      app.unmount();
    }
  });

  it('stays open while a turn runs and sends new input as steering', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replies = [
      JSON.stringify({ action: 'answer', message: 'first answer.' }),
      JSON.stringify({ action: 'answer', message: 'second answer.' }),
    ];
    let turn = 0;
    const llm: ChatClient = {
      async chat() {
        const reply = replies[turn++];
        if (reply === undefined) throw new Error('scripted model has no reply left');
        if (turn === 1) await held;
        return reply;
      },
    };
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const type = async (text: string) => {
      for (const char of text) {
        app.stdin.write(char);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      app.stdin.write('\r');
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await type('first');
      const running = await waitFor(() => app.lastFrame(), 'Working…');
      // The prompt does not step aside for the turn it started.
      expect(running).toContain(PROMPT_CHAR);

      await type('second');
      await waitFor(() => app.lastFrame(), '○ second');
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(2);

      release();
      await waitFor(() => app.lastFrame(), 'second answer.');
      expect(app.lastFrame()).not.toContain('queued');
    } finally {
      release();
      app.unmount();
    }
  });

  it('cancels the active turn while retaining the user steering in the record', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm: ChatClient = {
      async chat(_messages, options) {
        options?.signal?.addEventListener('abort', () => release(), { once: true });
        await held;
        throw new Error('interrupted');
      },
    };
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) }, llm });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    const type = async (text: string) => {
      for (const char of text) {
        app.stdin.write(char);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      app.stdin.write('\r');
    };
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await type('first');
      await waitFor(() => app.lastFrame(), 'Working…');
      await type('second');
      await waitFor(() => app.lastFrame(), '○ second');

      app.stdin.write('\x1b'); // esc
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(app.lastFrame()).not.toContain('queued');
      // Steering is retained as user input; Esc does not start another turn.
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(2);
    } finally {
      release();
      app.unmount();
    }
  });

  it('leaves scrolling to the terminal: finished rows are printed once, and the live rows fit the window', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    // Far more than one screen: each of these rows carries a blank line above
    // it, so forty of them are eighty rows in a window thirty tall.
    for (let n = 1; n <= 40; n++) {
      h.runtime.transcript.append({ type: 'user', text: `line-${pad(n)}` });
    }

    const app = render(<App runtime={h.runtime} />);
    try {
      // Every finished row goes out, however many there are: the terminal's
      // scrollback is the transcript now, and nothing here windows it. The
      // test renderer replays everything printed in front of each frame.
      const printed = await waitFor(() => app.lastFrame(), 'line-01');
      expect(printed).toContain('line-40');
      expect(printed).toContain(PROMPT_CHAR);
      // And nothing asks the terminal to report the mouse: its own selection
      // and its own wheel have to keep working over what was printed.
      expect(app.frames.join('')).not.toContain('[?1000h');

      // A task still running is live, and drawn above the prompt — pinned to
      // its end and clipped at the top, so the frame never outgrows the window.
      h.runtime.transcript.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'say a lot' });
      for (let n = 1; n <= 40; n++) {
        h.runtime.transcript.append({ type: 'session_update', agentId: 'claude', sessionId: 's', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk-${pad(n)}\n` },
        } });
      }
      const live = await waitFor(() => app.lastFrame(), 'chunk-40');
      expect(live).not.toContain('chunk-01');
      expect(live).toContain(PROMPT_CHAR);
      expect(live).toContain('line-40');

      // Once the task ends its rows are finished, and go out whole.
      h.runtime.transcript.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });
      const settled = await waitFor(() => app.lastFrame(), 'chunk-01');
      expect(settled).toContain('chunk-40');
    } finally {
      app.unmount();
    }
  });

  it('never lets the live part shrink on its own, so the prompt stays put', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    for (let n = 1; n <= 20; n++) {
      h.runtime.transcript.append({ type: 'user', text: `line-${pad(n)}` });
    }
    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), 'line-20');
      const height = () => (app.lastFrame() ?? '').split('\n').length;
      const settled = height();

      // A reply streams in, and the live part grows with it.
      for (let n = 1; n <= 6; n++) {
        h.runtime.transcript.append({ type: 'assistant_delta', stream: 1, text: `word-${n}\n` });
      }
      await waitFor(() => app.lastFrame(), 'word-6');
      const grown = height();
      expect(grown).toBeGreaterThan(settled);

      // Retracted — what streamed was a tool call's preamble, not the answer.
      // The rows it took stay in the frame as air rather than leaving the
      // prompt to climb the screen.
      h.runtime.transcript.append({ type: 'assistant', stream: 1, text: '' });
      const deadline = Date.now() + 2_000;
      while ((app.lastFrame() ?? '').includes('word-6')) {
        if (Date.now() > deadline) throw new Error('the retraction never drew');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(height()).toBe(grown);

      // The same when a menu closes: the rows it took stay.
      app.stdin.write('/');
      await waitFor(() => app.lastFrame(), '/clear');
      const withMenu = height();
      app.stdin.write('\u001B');
      const gone = Date.now() + 2_000;
      while ((app.lastFrame() ?? '').includes('/clear')) {
        if (Date.now() > gone) throw new Error('the menu never closed');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(height()).toBe(withMenu);
    } finally {
      app.unmount();
    }
  });

  it('starts the screen over on /clear', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([JSON.stringify({ action: 'answer', message: 'Hello there.' })]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('hi');
      await waitFor(() => app.lastFrame(), 'Hello there.');

      app.stdin.write('/clear');
      app.stdin.write('\r');
      // What was printed is gone with the screen; the header comes back with
      // the first row of the new printing.
      const frame = await waitFor(() => app.lastFrame(), 'context cleared');
      expect(frame).not.toContain('Hello there.');
      expect(frame.split('handsfree v')).toHaveLength(2);
    } finally {
      app.unmount();
    }
  });

  it('is what turns an unresolved rule into a question, and refuses on "n"', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);

      const decision = h.runtime.policy.resolve({
        kind: 'tool',
        agentId: 'claude',
        sessionId: 's1',
        toolKind: 'other',
        title: 'Do something unusual',
        locations: [],
        rawInput: null,
      });

      await waitFor(() => app.lastFrame(), 'wants to');
      expect(app.lastFrame()).toContain('Do something unusual');

      app.stdin.write('n');
      expect(await decision).toMatchObject({ verdict: 'deny', escalated: true });
    } finally {
      app.unmount();
    }
  });

  it('allows once when the answer is "y"', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);

      const decision = h.runtime.policy.resolve({
        kind: 'tool',
        agentId: 'claude',
        sessionId: 's1',
        toolKind: 'other',
        title: 'Do something unusual',
        locations: [],
        rawInput: null,
      });
      await waitFor(() => app.lastFrame(), 'wants to');

      app.stdin.write('y');
      expect(await decision).toMatchObject({ verdict: 'allow', escalated: true });
    } finally {
      app.unmount();
    }
  });

  it('goes back to denying escalations once the UI is gone', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    await waitFor(() => app.lastFrame(), PROMPT_CHAR);
    app.unmount();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const decision = await h.runtime.policy.resolve({
      kind: 'tool',
      agentId: 'claude',
      sessionId: 's1',
      toolKind: 'other',
      title: 'Do something unusual',
      locations: [],
      rawInput: null,
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('nobody available');
  });

  it('draws an answer as markdown rather than as its source', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([
        JSON.stringify({
          action: 'answer',
          message: '## Findings\n\n- the first\n- the second\n\n```ts\nconst a = 1;\n```',
        }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('what did you find');
      const frame = await waitFor(() => app.lastFrame(), 'Findings');

      // The heading and the fence are styling now, not characters on screen.
      expect(frame).not.toContain('##');
      expect(frame).not.toContain('```');
      expect(frame).toContain('- the first');
      expect(frame).toContain('const a = 1;');
    } finally {
      app.unmount();
    }
  });

  it('puts a permission question on screen and sends the answer back', async () => {
    const answers: string[] = [];
    const h = harness({
      agents: {
        claude: fakeAgent({
          script: () => [
            {
              do: 'ask',
              title: 'Do something unusual',
              kind: 'other',
              onAnswer: (id) => answers.push(id),
            },
          ],
        }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', kind: 'change', prompt: 'go' } }),
        JSON.stringify({ action: 'answer', message: 'done.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      const turn = h.runtime.conversation.send('do the unusual thing');
      await waitFor(() => app.lastFrame(), 'allow once');

      app.stdin.write('y');
      await turn;
      expect(answers).toEqual(['once']);
    } finally {
      app.unmount();
    }
  });

  it('fills in the form an agent stopped to ask, and hands it back', async () => {
    const answers: unknown[] = [];
    const h = harness({
      agents: {
        claude: fakeAgent({
          script: () => [
            {
              do: 'elicit',
              message: 'Rewrite the module or patch it?',
              schema: {
                type: 'object',
                properties: {
                  approach: {
                    type: 'string',
                    title: 'Which approach?',
                    enum: ['rewrite', 'patch'],
                  },
                  name: { type: 'string', title: 'Name it' },
                },
                required: ['approach'],
              },
              onAnswer: (response) => answers.push(response),
            },
          ],
        }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'call', tool: 'agent', input: { agent: 'claude', kind: 'change', prompt: 'fix it' } }),
        JSON.stringify({ action: 'answer', message: 'done.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      const turn = h.runtime.conversation.send('fix the module');
      await waitFor(() => app.lastFrame(), 'Which approach?');
      expect(app.lastFrame()).toContain('2) patch');

      app.stdin.write('2');
      // The second field is optional and free text; what is typed is the answer.
      await waitFor(() => app.lastFrame(), 'Name it');
      app.stdin.write('notes');
      await waitFor(() => app.lastFrame(), 'notes');
      app.stdin.write('\r');

      await turn;
      expect(answers).toEqual([
        { action: 'accept', content: { approach: 'patch', name: 'notes' } },
      ]);
    } finally {
      app.unmount();
    }
  });

  it('shows a tool permission request without policy configuration and continues on approval', async () => {
    const answers: string[] = [];
    const agent = fakeAgent({ script: () => [
      { do: 'ask', title: 'Show uncommitted change summary', kind: 'execute',
        rawInput: { command: 'git diff --stat' }, onAnswer: (id) => answers.push(id) },
      { do: 'say', text: 'Inspection continued.' },
    ] });
    const h = harness({ agents: { claude: agent } });
    open = h;
    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      const turn = h.runtime.conversation.send('@claude 너 뭐하고있어?');
      const frame = await waitFor(() => app.lastFrame(), 'allow once');
      expect(frame).toContain('Show uncommitted change summary');
      expect(frame).toContain('git diff --stat');
      expect(answers).toEqual([]);
      app.stdin.write('y');
      await turn;
      expect(answers).toEqual(['once']);
      await waitFor(() => app.lastFrame(), 'Inspection continued.');
    } finally { app.unmount(); }
  });

  it('cycles the permission mode on shift+tab, and says so under the prompt', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      // The default is on screen too, in the row under the hints.
      const opening = await waitFor(() => app.lastFrame(), '⏵⏵ ask every time');
      expect(h.runtime.policy.mode).toBe('ask');

      app.stdin.write('\u001B[Z'); // shift+tab
      const bypass = await waitFor(() => app.lastFrame(), '⏵⏵ bypass permissions');
      expect(h.runtime.policy.mode).toBe('bypass');
      const lines = bypass.split('\n');
      const hints = lines.findIndex((line) => line.includes('/ for commands'));
      expect(hints).toBeGreaterThan(-1);
      expect(lines[hints + 1]).toContain('⏵⏵ bypass permissions');

      // Round again, and the row says the default again, where it was.
      app.stdin.write('\u001B[Z');
      const back = await waitFor(() => app.lastFrame(), '⏵⏵ ask every time');
      expect(back).toContain('/ for commands');
      expect(back.split('\n').length).toBe(opening.split('\n').length);
      expect(h.runtime.policy.mode).toBe('ask');
    } finally {
      app.unmount();
    }
  });

  it('answers the question on screen when the mode moves to bypass', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      const decision = h.runtime.policy.resolve({
        kind: 'exec',
        agentId: 'claude',
        sessionId: 's1',
        command: 'git',
        args: ['commit', '-m', 'wip'],
        cwd: undefined,
      });
      const asked = await waitFor(() => app.lastFrame(), 'allow once');
      expect(asked).toContain('shift+tab');

      // In bypass it is not, and the switch is the answer.
      app.stdin.write('\u001B[Z');
      expect(await decision).toMatchObject({
        verdict: 'allow',
        rule: 'exec',
        escalated: true,
        mode: 'bypass',
      });
      await waitFor(() => app.lastFrame(), '⏵⏵ bypass permissions');
    } finally {
      app.unmount();
    }
  });

  it('approves every queued permission when the mode moves to bypass', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      config: {},
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      const write = h.runtime.policy.resolve({
        kind: 'fs.write',
        agentId: 'claude',
        sessionId: 's1',
        path: path.join(h.workspaceDir, 'notes.txt'),
        bytes: 5,
      });
      await waitFor(() => app.lastFrame(), 'write notes.txt');
      const commit = h.runtime.policy.resolve({
        kind: 'exec',
        agentId: 'claude',
        sessionId: 's1',
        command: 'git',
        args: ['commit', '-m', 'wip'],
        cwd: undefined,
      });

      app.stdin.write('\u001B[Z');
      expect(await write).toMatchObject({ verdict: 'allow', rule: 'fs.write', mode: 'bypass' });
      expect(await commit).toMatchObject({ verdict: 'allow', escalated: true, mode: 'bypass' });
      await waitFor(() => app.lastFrame(), '⏵⏵ bypass permissions');
    } finally {
      app.unmount();
    }
  });
});
