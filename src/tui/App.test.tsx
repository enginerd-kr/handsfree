import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from './App.js';
import { ConfigSchema, type Config } from '../config/schema.js';

const ENTER = '\r';
const TAB = '\t';
const ARROW_UP = '\u001B[A';
const ARROW_DOWN = '\u001B[B';

function makeConfig(): Config {
  return ConfigSchema.parse({ workspaceRoot: `${process.env.TMPDIR ?? '/tmp'}/handsfree-app-test` });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('App slash commands', () => {
  it('shows the command menu when typing /', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={makeConfig()} />);
    await tick();
    stdin.write('/');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('/tasks');
    expect(frame).toContain('/exit');
    unmount();
  });

  it('filters the menu and tab-completes', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={makeConfig()} />);
    await tick();
    stdin.write('/ta');
    await tick();
    expect(lastFrame()).toContain('/tasks');
    expect(lastFrame()).not.toContain('/help');
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('❯ /tasks');
    unmount();
  });

  it('runs /tasks and prints the empty-state message', async () => {
    const { frames, stdin, unmount } = render(<App config={makeConfig()} />);
    await tick();
    stdin.write('/tasks');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(frames.join('\n')).toContain('No tasks yet this session.');
    unmount();
  });

  it('runs the selected suggestion on enter with partial input', async () => {
    const { frames, stdin, unmount } = render(<App config={makeConfig()} />);
    await tick();
    stdin.write('/he');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(frames.join('\n')).toContain('Commands:');
    unmount();
  });

  it('navigates the menu with arrows', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={makeConfig()} />);
    await tick();
    stdin.write('/');
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(TAB);
    await tick();
    expect(lastFrame()).toContain('❯ /tasks');
    unmount();
  });

  it('reports unknown commands', async () => {
    const { frames, stdin, unmount } = render(<App config={makeConfig()} />);
    await tick();
    stdin.write('/zzz');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(frames.join('\n')).toContain('Unknown command: /zzz');
    unmount();
  });

  it('recalls the previous message with the up arrow', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={makeConfig()} />);
    await tick();
    stdin.write('/help');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).not.toContain('❯ /help');

    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain('❯ /help');
    unmount();
  });

  it('returns to the half-typed line when arrowing back down', async () => {
    const { lastFrame, stdin, unmount } = render(<App config={makeConfig()} />);
    await tick();
    stdin.write('/help');
    await tick();
    stdin.write(ENTER);
    await tick();

    stdin.write('draft');
    await tick();
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame()).toContain('❯ /help');
    stdin.write(ARROW_DOWN);
    await tick();
    expect(lastFrame()).toContain('❯ draft');
    unmount();
  });

  it('keeps the input live so typing is never blocked', async () => {
    const { lastFrame, unmount } = render(<App config={makeConfig()} />);
    await tick();
    expect(lastFrame()).toContain('describe a task, or / for commands');
    unmount();
  });

  it('renders the banner with model and run dir', async () => {
    const { frames, unmount } = render(<App config={makeConfig()} />);
    await tick();
    const all = frames.join('\n');
    expect(all).toContain('handsfree');
    expect(all).toContain('google/gemma-3-12b');
    unmount();
  });
});
