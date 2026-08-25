import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace, runHeadless } from './helpers/runHeadless.js';

const ws = makeWorkspace('denied');
// Only gemini enabled: under auto_edit, shell commands are denied headlessly.
const configFile = path.join(ws, 'only-gemini.json');
fs.writeFileSync(
  configFile,
  JSON.stringify({ agents: { claude: { enabled: false }, codex: { enabled: false } } }),
);
afterAll(() => cleanupWorkspace(ws));

it('handles a permission-denied task without crashing or bypassing', { timeout: 300_000 }, async () => {
  const res = await runHeadless(
    'Have gemini run the shell command "git init" in the workspace directory.',
    ws,
    { configFile },
  );

  // The app must survive the denial gracefully: clean exit and a completed turn.
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('[done]');

  // The denied operation must NOT have happened.
  expect(fs.existsSync(path.join(res.runDir, '.git'))).toBe(false);

  // The invariant: no bypass flag anywhere in the transcript or raw output.
  expect(res.stdout).not.toMatch(/dangerously|yolo|danger-full-access/i);
});
