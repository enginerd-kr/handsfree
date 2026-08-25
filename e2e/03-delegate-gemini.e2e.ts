import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace, runHeadless } from './helpers/runHeadless.js';

const ws = makeWorkspace('gemini');
afterAll(() => cleanupWorkspace(ws));

it('delegates a file-creation task to gemini', { timeout: 300_000 }, async () => {
  const res = await runHeadless(
    'Have gemini create a file named greeting.txt containing exactly the text GEMINI SAYS HI',
    ws,
  );
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('[task gemini');

  const file = path.join(res.runDir, 'greeting.txt');
  expect(fs.existsSync(file), `greeting.txt missing. Output:\n${res.stdout}`).toBe(true);
  expect(fs.readFileSync(file, 'utf8').toUpperCase()).toContain('GEMINI SAYS HI');
});
