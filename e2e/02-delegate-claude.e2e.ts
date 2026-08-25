import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace, runHeadless } from './helpers/runHeadless.js';

const ws = makeWorkspace('claude');
afterAll(() => cleanupWorkspace(ws));

it('delegates a file-creation task to claude', { timeout: 300_000 }, async () => {
  const res = await runHeadless(
    'Have claude create a file named hello.txt containing exactly the text HELLO HANDSFREE',
    ws,
  );
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('[task claude');
  expect(res.runDir).not.toBe('');

  const file = path.join(res.runDir, 'hello.txt');
  expect(fs.existsSync(file), `hello.txt missing. Output:\n${res.stdout}`).toBe(true);
  expect(fs.readFileSync(file, 'utf8').toUpperCase()).toContain('HELLO HANDSFREE');

  // File-based context flow: brief and result files exist for the task.
  const taskDir = path.join(res.runDir, 'tasks', '1-claude');
  expect(fs.existsSync(path.join(taskDir, 'brief.md'))).toBe(true);
  expect(fs.existsSync(path.join(taskDir, 'result.md'))).toBe(true);
});
