import { afterEach, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace } from './helpers/runHeadless.js';
import { TuiSession } from './support/tui.js';

/**
 * Visual TUI e2e: drives the real built binary in a pty and records
 * screenshots + a session video into the HTML report. Slash commands are
 * handled locally by the TUI, so no live LLM endpoint is needed.
 */

let ws: string;
let tui: TuiSession | undefined;

afterEach(async (ctx) => {
  // Playwright-style: auto-capture the screen at the moment of failure.
  if (ctx.task.result?.state === 'fail' && tui) await tui.screenshot('failure');
  await tui?.close();
  tui = undefined;
  cleanupWorkspace(ws);
});

function launch(): TuiSession {
  ws = makeWorkspace('tui');
  return new TuiSession({ args: ['--workspace', ws] });
}

it('shows the banner and slash-command menu', { timeout: 60_000 }, async () => {
  tui = launch();
  await tui.waitForText('describe a task');
  await tui.screenshot('01-banner');

  await tui.type('/');
  await tui.waitForText('Show available commands');
  await tui.screenshot('02-command-menu');

  await tui.type('he');
  await tui.waitForText('/help');
  expect(tui.screenText()).not.toContain('/tasks    Show');
  await tui.screenshot('03-menu-filtered');
});

it('runs /help, /status and /tasks via the command menu', { timeout: 60_000 }, async () => {
  tui = launch();
  await tui.waitForText('describe a task');

  await tui.type('/he');
  await tui.press('tab');
  await tui.waitForText('› /help');
  await tui.press('enter');
  await tui.waitForText('Shortcuts:');
  await tui.screenshot('01-help-output');

  await tui.type('/status');
  await tui.press('enter');
  await tui.waitForText('endpoint');
  await tui.screenshot('02-status-output');
  expect(tui.screenText()).toContain('0 ok · 0 failed · 0 running');

  await tui.type('/tasks');
  await tui.press('enter');
  await tui.waitForText('No tasks yet this session.');
  await tui.screenshot('03-tasks-empty');
});

it('exits cleanly via /exit', { timeout: 60_000 }, async () => {
  tui = launch();
  await tui.waitForText('describe a task');
  await tui.type('/exit');
  await tui.press('enter');
  const code = await tui.waitForExit();
  expect(code).toBe(0);
});
