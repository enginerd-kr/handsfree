import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace, runHeadless } from './helpers/runHeadless.js';

const ws = makeWorkspace('chain');
afterAll(() => cleanupWorkspace(ws));

it('chains two tasks sharing file context', { timeout: 600_000 }, async () => {
  const res = await runHeadless(
    'First have claude create a file named fruits.txt with the three lines: apple, banana, cherry (one per line, lowercase). ' +
      'Then have codex read fruits.txt and create fruits_upper.txt with the same lines uppercased.',
    ws,
    { timeoutMs: 580_000 },
  );
  expect(res.exitCode).toBe(0);

  const fruits = path.join(res.runDir, 'fruits.txt');
  const upper = path.join(res.runDir, 'fruits_upper.txt');
  expect(fs.existsSync(fruits), `fruits.txt missing. Output:\n${res.stdout}`).toBe(true);
  expect(fs.existsSync(upper), `fruits_upper.txt missing. Output:\n${res.stdout}`).toBe(true);

  const source = fs.readFileSync(fruits, 'utf8');
  const derived = fs.readFileSync(upper, 'utf8');
  for (const fruit of ['APPLE', 'BANANA', 'CHERRY']) {
    expect(source.toUpperCase()).toContain(fruit);
    expect(derived).toContain(fruit);
  }

  // context.md logged both tasks — the file-based context flow worked.
  const context = fs.readFileSync(path.join(res.runDir, 'context.md'), 'utf8');
  expect(context).toMatch(/Task 1/);
  expect(context).toMatch(/Task 2/);
});
