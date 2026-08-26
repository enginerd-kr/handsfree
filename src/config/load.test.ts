import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, loadConfig } from './load.js';

describe('legacy llm block', () => {
  it('is read as orchestration.local', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-config-'));
    try {
      fs.writeFileSync(
        path.join(dir, CONFIG_FILENAME),
        JSON.stringify({
          llm: { baseURL: 'http://localhost:9999/v1', model: 'legacy', maxHistoryMessages: 7 },
        }),
      );
      const { config } = loadConfig(dir);
      expect(config.orchestration.provider).toBe('local');
      expect(config.orchestration.local.baseURL).toBe('http://localhost:9999/v1');
      expect(config.orchestration.local.model).toBe('legacy');
      expect(config.orchestration.maxHistoryMessages).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yields to an orchestration block when both are present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-config-'));
    try {
      fs.writeFileSync(
        path.join(dir, CONFIG_FILENAME),
        JSON.stringify({
          llm: { model: 'legacy' },
          orchestration: { provider: 'acp' },
        }),
      );
      const { config } = loadConfig(dir);
      expect(config.orchestration.provider).toBe('acp');
      expect(config.orchestration.local.model).toBe('google/gemma-3-12b');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
