import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/tui/app.js';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';

let open: Harness | undefined;

afterEach(async () => {
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
  it('renders the transcript as it arrives', async () => {
    const h = harness({
      agents: { claude: fakeAgent({ script: () => [] }) },
      llm: scriptedModel([JSON.stringify({ action: 'answer', message: 'Hello there.' })]),
    });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), '>');
      await h.runtime.conversation.send('hi');
      const frame = await waitFor(() => app.lastFrame(), 'Hello there.');
      expect(frame).toContain('you');
    } finally {
      app.unmount();
    }
  });

  it('is what turns an unresolved rule into a question, and refuses on "n"', async () => {
    const h = harness({ agents: { claude: fakeAgent({ script: () => [] }) } });
    open = h;

    const app = render(<App runtime={h.runtime} />);
    try {
      await waitFor(() => app.lastFrame(), '>');

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
      await waitFor(() => app.lastFrame(), '>');

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
    await waitFor(() => app.lastFrame(), '>');
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
