import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath, loadConfig } from '../src/config/load.js';
import { ConfigSchema } from '../src/config/schema.js';
import { saveModelDefaults } from '../src/config/models.js';
import { ModelSettings } from '../src/ui/tui/model-settings.js';
import { App } from '../src/ui/tui/app.js';
import { harness, type Harness } from './harness.js';

const homes: string[] = [];
const apps: ReturnType<typeof render>[] = [];
let active: Harness | undefined;
afterEach(async () => {
  for (const app of apps.splice(0)) app.unmount();
  await active?.dispose();
  active = undefined;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function homeDirectory(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-settings-ui-'));
  homes.push(home);
  return home;
}

async function frame(app: ReturnType<typeof render>, text: string): Promise<string> {
  await vi.waitFor(() => expect(app.lastFrame()).toContain(text));
  return app.lastFrame()!;
}

async function press(app: ReturnType<typeof render>, ...keys: string[]) {
  for (const key of keys) {
    app.stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const DOWN = '\x1b[B';
const ENTER = '\r';
const CLEAR = '\x15';
const ESC = '\x1b';
const SAVE = '\x13';

describe('model settings screen', () => {
  it('edits the orchestrator and all three worker defaults, then reloads the saved file', async () => {
    const home = homeDirectory();
    const saved = vi.fn((before, next) => { saveModelDefaults(before, next, home); });
    const app = render(<ModelSettings config={ConfigSchema.parse({})} file={configPath(home)}
      rows={24} columns={80} models={{}} onSave={saved} onClose={() => {}} />);
    apps.push(app);
    await frame(app, 'Model settings');
    await press(app, ENTER, ENTER); // Local -> API -> Claude ACP.
    await frame(app, 'Claude (ACP)');
    await press(app, DOWN, ENTER, CLEAR, 'planner-test', ENTER);
    for (const model of ['claude-test', 'codex-test', 'gemini-test']) {
      await press(app, DOWN, ENTER, CLEAR, model, ENTER);
    }
    await press(app, SAVE);
    expect(saved).toHaveBeenCalledTimes(1);
    const config = loadConfig(undefined, home).config;
    expect(config.orchestration.provider).toBe('acp');
    expect(config.orchestration.acp.model).toBe('planner-test');
    expect(config.agents.claude?.model).toBe('claude-test');
    expect(config.agents.codex?.model).toBe('codex-test');
    expect(config.agents.gemini?.model).toBe('gemini-test');
    expect((app.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(23);
  });

  it('chooses from the advertised roster and restores a CLI default', async () => {
    const saved = vi.fn();
    const app = render(<ModelSettings config={ConfigSchema.parse({})} file="~/.handsfree/config.json"
      rows={24} columns={80} models={{ claude: [{ value: 'offered-a' }, { value: 'offered-b' }] }}
      onSave={saved} onClose={() => {}} />);
    apps.push(app);
    await frame(app, 'Model settings');
    await press(app, DOWN, DOWN, ENTER, DOWN, DOWN, DOWN, ENTER);
    await frame(app, 'offered-b');
    await press(app, SAVE);
    expect(saved.mock.calls[0]?.[1].agents.claude).toBe('offered-b');
    await press(app, ENTER, CLEAR, ENTER, SAVE);
    expect(saved.mock.calls[1]?.[1].agents.claude).toBe('');
  });

  it('cancels a field edit and cancels the screen without saving', async () => {
    const saved = vi.fn();
    const close = vi.fn();
    const app = render(<ModelSettings config={ConfigSchema.parse({})} file="~/.handsfree/config.json"
      rows={24} columns={80} models={{}} onSave={saved} onClose={close} />);
    apps.push(app);
    await frame(app, 'Model settings');
    await press(app, DOWN, ENTER, CLEAR, 'discard-me', ESC);
    expect(app.lastFrame()).not.toContain('discard-me');
    await press(app, ESC);
    expect(close).toHaveBeenCalledTimes(1);
    expect(saved).not.toHaveBeenCalled();
  });

  it('requires an endpoint model and keeps the draft visible after a save error', async () => {
    const app = render(<ModelSettings config={ConfigSchema.parse({})} file="~/.handsfree/config.json"
      rows={24} columns={80} models={{}} onSave={() => { throw new Error('Cannot write settings'); }} onClose={() => {}} />);
    apps.push(app);
    await frame(app, 'Model settings');
    await press(app, DOWN, ENTER, CLEAR, ENTER);
    await frame(app, 'Enter a model ID');
    await press(app, 'local-test', ENTER, SAVE);
    const current = await frame(app, 'Cannot write settings');
    expect(current).toContain('local-test');
    expect(current).toContain('Model settings *');
  });

  it('scrolls to every row in a short terminal and reports missing profiles', async () => {
    const saved = vi.fn();
    const app = render(<ModelSettings config={ConfigSchema.parse({ agents: {} })} file="~/.handsfree/config.json"
      rows={14} columns={50} models={{}} onSave={saved} onClose={() => {}} />);
    apps.push(app);
    await frame(app, 'Model settings');
    await press(app, DOWN, DOWN, ENTER);
    await frame(app, 'Claude is not configured');
    await press(app, DOWN, DOWN, DOWN);
    await frame(app, 'Save defaults');
    await press(app, ENTER);
    expect(saved).toHaveBeenCalledTimes(1);
    expect((app.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(13);
  });

  it('opens through /models, keeps input out of chat, and reads saved defaults on reopening', async () => {
    const home = homeDirectory();
    active = harness({ agents: {} });
    const app = render(<App runtime={active.runtime} settingsHome={home} />);
    apps.push(app);
    await frame(app, '❯');
    await press(app, '/models\r');
    await frame(app, 'Model settings');
    await press(app, DOWN, ENTER, CLEAR, 'saved-endpoint', ENTER, SAVE);
    await frame(app, 'Model defaults saved');
    expect(active.runtime.config.orchestration.local.model).not.toBe('saved-endpoint');
    expect(active.runtime.transcript.all().some((record) => record.type === 'user')).toBe(false);
    await press(app, '/settings\r');
    await frame(app, 'saved-endpoint');
    await press(app, ESC);
    expect(app.lastFrame()).not.toContain('Model settings');
    expect(loadConfig(undefined, home).config.orchestration.local.model).toBe('saved-endpoint');
  });
});
