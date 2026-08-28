import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableDebug, enableDebug } from '../src/debug.js';
import { App, menuFit } from '../src/ui/tui/app.js';
import { copyToClipboard } from '../src/ui/tui/clipboard.js';
import { DOT_BUSY, DOT_IDLE, PROMPT_CHAR } from '../src/ui/tui/theme.js';
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
      const frame = await waitFor(() => app.lastFrame(), '● debug');
      expect(frame).toContain('hf-debug.log');
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
      // The user's line is on screen, but no longer opened by a `>` — its
      // wash is what marks it now.
      expect(frame).toContain('hi');
      expect(frame).not.toContain('> hi');
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

      // Folded: the task is one line, and what the agent said is not on screen.
      expect(app.lastFrame()).toContain('ctrl+o');
      expect(app.lastFrame()).not.toContain('the long agent answer');

      app.stdin.write('\x0f'); // ctrl+o
      await waitFor(() => app.lastFrame(), 'the long agent answer');
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
      expect(app.lastFrame()).not.toContain('the long agent answer');

      // Type first: a click must not disturb what is half-written.
      app.stdin.write('half typed');
      await waitFor(() => app.lastFrame(), 'half typed');

      // Where the closing line actually landed, which is what the layout maths
      // has to agree with for a click to be aimed at the right task.
      const row = (app.lastFrame() ?? '').split('\n').findIndex((line) => line.includes('⎿'));
      expect(row).toBeGreaterThan(0);

      app.stdin.write(`\u001B[<0;3;${row + 1}M`); // press
      app.stdin.write(`\u001B[<0;3;${row + 1}m`); // release
      const frame = await waitFor(() => app.lastFrame(), 'the long agent answer');
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

      // The user's line has no gutter, so its text sits in the first column.
      const lines = (app.lastFrame() ?? '').split('\n');
      const from = lines.findIndex((line) => line.includes('hi') && !line.includes('Hello'));
      const to = lines.findIndex((line) => line.includes('Hello there.'));
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);

      // Down on the h of hi, across to past the end of the answer.
      app.stdin.write(`\u001B[<0;1;${from + 1}M`); // press
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
      expect(plain()).not.toContain('ello');
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
      // The bare slash offers everything, shortest name first: exit, help,
      // clear. Two steps down lands on the third.
      await press('/');
      await waitFor(() => app.lastFrame(), '/clear');
      await press('\x1b[B', '\x1b[B', '\r');

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
      expect(app.lastFrame()).not.toContain('@gemini');
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
      expect(plain()).not.toContain('@gemini ');

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
      await waitFor(() => app.lastFrame(), 'the long agent answer');

      // The agent's own words are neither the opening row nor the closing one,
      // but they belong to the task, so a click on them folds it back up.
      const row = (app.lastFrame() ?? '')
        .split('\n')
        .findIndex((line) => line.includes('the long agent answer'));
      expect(row).toBeGreaterThan(0);
      app.stdin.write(`\u001B[<0;3;${row + 1}m`);
      const deadline = Date.now() + 2_000;
      while ((app.lastFrame() ?? '').includes('the long agent answer')) {
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
    // Korean is double-width and the brief is long enough to wrap several
    // times: if the row maths counted characters the click would miss.
    const task = '워크스페이스 안에 파일을 만들고 그 안에 정확히 다음 문장을 적어줘: '.repeat(3);
    const h = harness({
      agents: {
        claude: fakeAgent({ script: () => [{ do: 'say', text: 'the long agent answer' }] }),
      },
      llm: scriptedModel([
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task }),
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
      expect(row).toBeGreaterThan(3); // the brief really did wrap

      app.stdin.write(`[<0;3;${row + 1}m`);
      await waitFor(() => app.lastFrame(), 'the long agent answer');
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

      // The terminal answers as if the frame began three rows down the screen:
      // the cursor rests on the line under the frame, so its row is the frame
      // top plus the frame's height.
      app.stdin.write(`[${lines.length + 3 + 1};1R`);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A click aimed by the old anchor now lands on nothing.
      app.stdin.write(`[<0;3;${row + 1}m`);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(app.lastFrame()).not.toContain('the long agent answer');

      // Aimed three rows lower, it opens the task again.
      app.stdin.write(`[<0;3;${row + 3 + 1}m`);
      const frame = await waitFor(() => app.lastFrame(), 'the long agent answer');
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
      expect(app.lastFrame()).not.toContain('the long agent answer');
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
        JSON.stringify({ action: 'delegate', agent: 'claude', kind: 'answer', task: 'go' }),
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
      await waitFor(() => app.lastFrame(), 'the agent answer');

      // The click lands on the last line of a block whose earlier lines are
      // markdown — so it only folds if those lines were measured correctly.
      const row = (app.lastFrame() ?? '')
        .split('\n')
        .findIndex((line) => line.includes('the agent answer'));
      expect(row).toBeGreaterThan(0);
      app.stdin.write(`\u001B[<0;3;${row + 1}m`);

      const deadline = Date.now() + 2_000;
      while ((app.lastFrame() ?? '').includes('the agent answer')) {
        if (Date.now() > deadline) throw new Error('the click never folded the task');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      app.unmount();
    }
  });
});
