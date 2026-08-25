import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace, runHeadless } from './helpers/runHeadless.js';

const ws = makeWorkspace('codex');
afterAll(() => cleanupWorkspace(ws));

it('delegates a file-creation task to codex', { timeout: 300_000 }, async () => {
  const res = await runHeadless(
    'Have codex create a file named note.txt containing exactly the text CODEX WAS HERE',
    ws,
  );
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('[task codex');

  const file = path.join(res.runDir, 'note.txt');
  expect(fs.existsSync(file), `note.txt missing. Output:\n${res.stdout}`).toBe(true);
  expect(fs.readFileSync(file, 'utf8').toUpperCase()).toContain('CODEX WAS HERE');
});
