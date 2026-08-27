import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { disableDebug, enableDebug } from '../src/debug.js';
import { App } from '../src/ui/tui/app.js';
import { PROMPT_CHAR } from '../src/ui/tui/theme.js';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';
import type { ChatClient } from '../src/brain/client.js';

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
      expect(frame).toContain('> hi');
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
});
