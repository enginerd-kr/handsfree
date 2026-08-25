import { afterAll, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace, runHeadless } from './helpers/runHeadless.js';

const ws = makeWorkspace('core');
afterAll(() => cleanupWorkspace(ws));

it('answers a simple question via the local LLM without delegating', { timeout: 120_000 }, async () => {
  const res = await runHeadless('What is 2+2? Answer with just the number.', ws, {
    timeoutMs: 90_000,
  });
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('[assistant]');
  expect(res.stdout).toMatch(/4/);
  expect(res.stdout).not.toContain('[task ');
  expect(res.stdout).toContain('[done]');
});
