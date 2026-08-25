import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    globalSetup: ['e2e/global-setup.ts'],
    reporters: ['default', './e2e/support/reporter.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 30_000,
  },
});
