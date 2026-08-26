import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
  },
});
