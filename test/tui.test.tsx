import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableDebug, enableDebug } from '../src/debug.js';
import { App, menuFit } from '../src/ui/tui/app.js';
import { copyToClipboard } from '../src/ui/tui/clipboard.js';
import { DOT_BUSY, DOT_IDLE, PLAN_BUSY, PLAN_IDLE, PROMPT_CHAR } from '../src/ui/tui/theme.js';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import type { ChatClient } from '../src/brain/client.js';

// The one road out of the process a drag takes: a test must watch it, and must
// never put its scraps on the machine's real clipboard.
vi.mock('../src/ui/tui/clipboard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/tui/clipboard.js')>()),
  copyToClipboard: vi.fn(),
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

      // It is the empty transcript standing in, and nothing more: the first
      // line sent takes the pane back.
      await h.runtime.conversation.send('hi');
      const after = await waitFor(() => app.lastFrame(), 'Hello there.');
      expect(after).not.toContain('What are we working on today?');
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
      const asked = lines.find((line) => line.includes('hi') && !line.includes('Hello'));
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
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: 'who?' }),
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
      // The name stands over the answer, and the answer hangs in the text column.
      expect(frame).toContain('claude\n  I am claude.');
      expect(frame).not.toContain('REPORT');
      expect(frame).not.toContain('task 1');
    } finally {
      app.unmount();
    }
  });

  it('starts a code block on the line under the agent\'s name, in one column', async () => {
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
      const name = lines.findIndex((line) => /claude\s*$/.test(line));
      expect(name).toBeGreaterThan(-1);
      // The block's lines share a column, the first no further right than the rest.
      expect(lines[name + 1]?.indexOf('function')).toBe(lines[name + 3]?.indexOf('}'));
    } finally {
      app.unmount();
    }
  });

  it('opens the task a click lands on, and leaves the prompt alone', async () => {
    const h = harness({
      agents: {
        claude: fakeAgent({ script: () => [{ do: 'say', text: 'the long agent answer' }] }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: '안녕?' }),
        JSON.stringify({ action: 'answer', message: 'claude answered.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('who are you');
      await waitFor(() => app.lastFrame(), 'claude answered.');
      expect(app.lastFrame()).not.toContain('안녕?');

      // Type first: a click must not disturb what is half-written.
      app.stdin.write('half typed');
      await waitFor(() => app.lastFrame(), 'half typed');

      // Where the closing line actually landed, which is what the layout maths
      // has to agree with for a click to be aimed at the right task.
      const row = (app.lastFrame() ?? '').split('\n').findIndex((line) => line.includes('⎿'));
      expect(row).toBeGreaterThan(0);

      app.stdin.write(`\u001B[<0;3;${row + 1}M`); // press
      app.stdin.write(`\u001B[<0;3;${row + 1}m`); // release
      const frame = await waitFor(() => app.lastFrame(), '안녕?');
      expect(frame).toContain('half typed');
      expect(frame).not.toContain('[<0;3;');
    } finally {
      app.unmount();
    }
  });

  it('copies what a drag crossed, and says so under the prompt', async () => {
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

      // The user's line sits one gutter in, like every other row.
      const lines = (app.lastFrame() ?? '').split('\n');
      const from = lines.findIndex((line) => line.includes('hi') && !line.includes('Hello'));
      const to = lines.findIndex((line) => line.includes('Hello there.'));
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);

      // Down on the h of hi, across to past the end of the answer.
      app.stdin.write(`\u001B[<0;3;${from + 1}M`); // press
      app.stdin.write(`\u001B[<32;15;${to + 1}M`); // drag
      // The crossed cells wear the selection wash while the button is down.
      await waitFor(() => app.lastFrame(), '48;2;38;79;120');
      app.stdin.write(`\u001B[<0;15;${to + 1}m`); // release
      // The blank row between the two is on screen, so the copy keeps it.
      const frame = await waitFor(() => app.lastFrame(), 'copied 3 lines to the clipboard');
      expect(frame).not.toContain('48;2;38;79;120');

      const copy = vi.mocked(copyToClipboard);
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copy.mock.calls[0]?.[0]).toBe('hi\n\nHello there.');
    } finally {
      app.unmount();
    }
  });

  it('keeps accepting prompt input after a hover report', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      app.stdin.write('\u001B[<35;3;1M'); // all-motion, with no button held
      await new Promise((resolve) => setTimeout(resolve, 0));
      app.stdin.write('still works');
      await waitFor(() => app.lastFrame(), 'still works');
    } finally {
      app.unmount();
    }
  });

  it('keeps characters in typing order after a hover report', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      // A hover report is swallowed before it reaches the prompt, but it must
      // also leave no trace in whatever cursor state the input keeps: typed
      // one keypress at a time, "/exit" once came out as "exit/".
      app.stdin.write('[<35;3;1M');
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const char of '/exit') {
        app.stdin.write(char);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const frame = await waitFor(() => app.lastFrame(), 'exit');
      expect(frame).toContain('/exit');
      expect(frame).not.toContain('exit/');
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
      const closed = (app.lastFrame() ?? '').split('\n').length;

      app.stdin.write('/');
      await waitFor(() => app.lastFrame(), '/clear');
      expect(app.lastFrame()).toContain('/help');

      // The frame is a fixed height. A menu that grew it would scroll the
      // whole UI, so the rows it takes have to come out of the transcript.
      expect((app.lastFrame() ?? '').split('\n').length).toBe(closed);
    } finally {
      app.unmount();
    }
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
      // name: cost, exit, help, clear. Three steps down lands on the fourth.
      await press('/');
      await waitFor(() => app.lastFrame(), '/clear');
      await press('\x1b[B', '\x1b[B', '\x1b[B', '\r');

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
      const closed = (app.lastFrame() ?? '').split('\n').length;

      app.stdin.write('@');
      const frame = await waitFor(() => app.lastFrame(), '@gemini');
      expect(frame).toContain('@claude');

      // Same rule as the command menu: the rows come out of the transcript,
      // never out of the frame's height.
      expect((app.lastFrame() ?? '').split('\n').length).toBe(closed);
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
      // And the header roster stays names only.
      expect(frame).toContain('google/gemma-3-12b · claude, gemini\n');
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
      // The row above the roll call is the transcript's, and it is blank.
      expect(lines[roll - 1]?.trim()).toBe('');
      // The roll call is the fifth row from the bottom, as it has always been.
      expect(lines.length - roll).toBe(5);
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
    // six-model roster to five rows, losing the last one.
    expect(menuFit('model', 24)).toBeGreaterThanOrEqual(6);
    // A slash still yields to the transcript at the same height, because its
    // list narrows as the name is typed and a cut there loses nothing.
    expect(menuFit('command', 24)).toBe(5);
    // Shorter still, and the menu goes rather than the frame overflowing.
    expect(menuFit('model', 14)).toBe(0);
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

  it('stays open while a turn runs, and sends what was typed once it ends', async () => {
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
      await waitFor(() => app.lastFrame(), '1 queued');
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(1);

      release();
      await waitFor(() => app.lastFrame(), 'second answer.');
      expect(app.lastFrame()).not.toContain('queued');
    } finally {
      release();
      app.unmount();
    }
  });

  it('drops what is queued when the turn in front of it is interrupted', async () => {
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
      await waitFor(() => app.lastFrame(), '1 queued');

      app.stdin.write('\x1b'); // esc
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(app.lastFrame()).not.toContain('queued');
      // Only the first prompt was ever sent; the queued one left with the turn.
      expect(h.runtime.transcript.all().filter((r) => r.type === 'user')).toHaveLength(1);
    } finally {
      release();
      app.unmount();
    }
  });

  it('folds an open task from a click anywhere inside it', async () => {
    const h = harness({
      agents: {
        claude: fakeAgent({ script: () => [{ do: 'say', text: 'the long agent answer' }] }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: '안녕?' }),
        JSON.stringify({ action: 'answer', message: 'claude answered.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('who are you');
      await waitFor(() => app.lastFrame(), 'claude answered.');

      app.stdin.write('\x0f'); // ctrl+o, so the block has inner rows
      await waitFor(() => app.lastFrame(), '안녕?');

      // The agent's answer is neither the opening row nor the closing one,
      // but it belongs to the task, so a click on it folds the task back up.
      const row = (app.lastFrame() ?? '')
        .split('\n')
        .findIndex((line) => line.includes('the long agent answer'));
      expect(row).toBeGreaterThan(0);
      app.stdin.write(`\u001B[<0;3;${row + 1}m`);
      const deadline = Date.now() + 2_000;
      while ((app.lastFrame() ?? '').includes('안녕?')) {
        if (Date.now() > deadline) throw new Error('the click never folded the task');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      app.unmount();
    }
  });

  it('scrolls the transcript with the wheel while the prompt stays put', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    // Far more than one screen: each of these rows carries a blank line above
    // it, so forty of them are eighty rows in a viewport nineteen tall.
    for (let n = 1; n <= 40; n++) {
      h.runtime.transcript.append({ type: 'user', text: `line-${String(n).padStart(2, '0')}` });
    }

    const app = render(<App runtime={h.runtime} />);
    try {
      const start = await waitFor(() => app.lastFrame(), 'line-40');
      expect(start).not.toContain('line-01');
      const height = start.split('\n').length;

      // Enough turns of the wheel to reach the top of the transcript.
      for (let turn = 0; turn < 30; turn++) app.stdin.write('\u001B[<64;3;10M');
      const top = await waitFor(() => app.lastFrame(), 'line-01');
      expect(top).not.toContain('line-40');
      // The prompt does not move, and neither does the mark above it — and the
      // hint under it says the view has stopped following what arrives.
      expect(top).toContain(PROMPT_CHAR);
      expect(top).toContain('handsfree');
      expect(top).toContain('scrolled up');
      expect(top.split('\n')).toHaveLength(height);

      // And back down to where it was.
      for (let turn = 0; turn < 30; turn++) app.stdin.write('\u001B[<65;3;10M');
      const end = await waitFor(() => app.lastFrame(), 'line-40');
      expect(end).not.toContain('line-01');

      // Once it is following the end again, whatever arrives next is on screen.
      h.runtime.transcript.append({ type: 'user', text: 'line-41' });
      await waitFor(() => app.lastFrame(), 'line-41');
    } finally {
      app.unmount();
    }
  });

  it('pays a whole burst of wheel reports out, even fused into one chunk', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    for (let n = 1; n <= 40; n++) {
      h.runtime.transcript.append({ type: 'user', text: `line-${String(n).padStart(2, '0')}` });
    }

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), 'line-40');

      // A fast flick: the terminal fuses the reports into one stdin chunk.
      // The rows pool and drain over frames rather than landing in one
      // render, but every one of them lands — the flick still reaches the
      // top, not most of the way to it.
      app.stdin.write('\u001B[<64;3;10M'.repeat(30));
      const top = await waitFor(() => app.lastFrame(), 'line-01');
      expect(top).not.toContain('line-40');

      // And a fused flick back down re-pins the view to the end.
      app.stdin.write('\u001B[<65;3;10M'.repeat(30));
      await waitFor(() => app.lastFrame(), 'line-40');
      h.runtime.transcript.append({ type: 'user', text: 'line-41' });
      await waitFor(() => app.lastFrame(), 'line-41');
    } finally {
      app.unmount();
    }
  });

  it('scrolls a page at a time from the keyboard, and a row at a time with shift', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;
    for (let n = 1; n <= 40; n++) {
      h.runtime.transcript.append({ type: 'user', text: `line-${String(n).padStart(2, '0')}` });
    }

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), 'line-40');

      // A page is the viewport less the row it keeps for the eye to land on:
      // nine of these two-row items.
      app.stdin.write('\u001B[5~'); // page up
      const paged = await waitFor(() => app.lastFrame(), 'line-22');
      expect(paged).not.toContain('line-40');

      // Shift and an arrow move a single row, which is half of one item: two
      // of them bring the next one fully into view.
      app.stdin.write('\u001B[1;2B'); // shift+down
      app.stdin.write('\u001B[1;2B');
      const nudged = await waitFor(() => app.lastFrame(), 'line-32');
      expect(nudged).not.toContain('line-22');

      app.stdin.write('\u001B[6~'); // page down, back to the end
      const end = await waitFor(() => app.lastFrame(), 'line-40');
      expect(end).not.toContain('line-23');
    } finally {
      app.unmount();
    }
  });

  it('does not highlight unrelated rows before a task is hovered', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      // The test renderer exposes ANSI styling in its frame; no hover state
      // must be inferred from two undefined task ids.
      expect(app.lastFrame()).not.toContain('\u001B[100m');
    } finally {
      app.unmount();
    }
  });

  it('still aims true when the rows above the target wrap', async () => {
    // Korean is double-width and the answer is long enough to wrap several
    // times: if the row maths counted characters the click would miss.
    const answer = '워크스페이스 안에 파일을 만들고 그 안에 정확히 다음 문장을 적었습니다: '.repeat(3);
    const h = harness({
      agents: {
        claude: fakeAgent({ script: () => [{ do: 'say', text: answer }] }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: '안녕?' }),
        JSON.stringify({ action: 'answer', message: 'claude answered.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('길게 물어봐');
      await waitFor(() => app.lastFrame(), 'claude answered.');

      const row = (app.lastFrame() ?? '').split('\n').findIndex((line) => line.includes('⎿'));
      expect(row).toBeGreaterThan(3); // the answer really did wrap

      app.stdin.write(`[<0;3;${row + 1}m`);
      await waitFor(() => app.lastFrame(), '안녕?');
    } finally {
      app.unmount();
    }
  });

  it('re-anchors clicks where the terminal says the frame is', async () => {
    const h = harness({
      agents: {
        claude: fakeAgent({ script: () => [{ do: 'say', text: 'the long agent answer' }] }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: '안녕?' }),
        JSON.stringify({ action: 'answer', message: 'claude answered.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('who are you');
      await waitFor(() => app.lastFrame(), 'claude answered.');

      const lines = (app.lastFrame() ?? '').replace(/\n$/, '').split('\n');
      const row = lines.findIndex((line) => line.includes('⎿'));
      expect(row).toBeGreaterThan(0);

      // The terminal answers as if the frame began four rows down the screen:
      // the cursor rests on the line under the frame, so its row is the frame
      // top plus the frame's height. Four, so that a click aimed by the old
      // anchor falls past the whole task — its name row, its gap — onto the
      // person's own line.
      app.stdin.write(`[${lines.length + 4 + 1};1R`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A click aimed by the old anchor now lands on nothing.
      app.stdin.write(`[<0;3;${row + 1}m`);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(app.lastFrame()).not.toContain('안녕?');

      // Aimed four rows lower, it opens the task again.
      app.stdin.write(`[<0;3;${row + 4 + 1}m`);
      const frame = await waitFor(() => app.lastFrame(), '안녕?');
      expect(frame).not.toContain(';1R');
    } finally {
      app.unmount();
    }
  });

  it('ignores a click that lands on nothing clickable', async () => {
    const h = harness({
      agents: {
        claude: fakeAgent({ script: () => [{ do: 'say', text: 'the long agent answer' }] }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: '안녕?' }),
        JSON.stringify({ action: 'answer', message: 'claude answered.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('who are you');
      await waitFor(() => app.lastFrame(), 'claude answered.');

      app.stdin.write('\u001B[<0;3;1M');
      app.stdin.write('\u001B[<0;3;1m'); // the header row
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(app.lastFrame()).not.toContain('안녕?');
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

  it('still aims a click true when a markdown answer sits above the target', async () => {
    // The whole point of rendering markdown into the row's own text is that
    // `heightOf` keeps measuring what is drawn. A block that measures short by
    // even one row sends every click below it to the wrong task.
    const h = harness({
      agents: {
        claude: fakeAgent({
          script: () => [
            { do: 'say', text: '## Plan\n\n- read the file\n- change one line\n\nthe agent answer' },
          ],
        }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: 'read it and change one line' }),
        JSON.stringify({ action: 'answer', message: 'claude answered.' }),
      ]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), PROMPT_CHAR);
      await h.runtime.conversation.send('who are you');
      await waitFor(() => app.lastFrame(), 'claude answered.');

      app.stdin.write('\x0f'); // ctrl+o, so the block has inner rows: the brief
      await waitFor(() => app.lastFrame(), 'read it and change one line');

      // The click lands on the last line of a block whose earlier lines are
      // markdown — so it only folds if those lines were measured correctly.
      const row = (app.lastFrame() ?? '')
        .split('\n')
        .findIndex((line) => line.includes('the agent answer'));
      expect(row).toBeGreaterThan(0);
      app.stdin.write(`\u001B[<0;3;${row + 1}m`);

      const deadline = Date.now() + 2_000;
      while ((app.lastFrame() ?? '').includes('read it and change one line')) {
        if (Date.now() > deadline) throw new Error('the click never folded the task');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
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
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'change', task: 'go' }),
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
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'change', task: 'fix it' }),
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
});
