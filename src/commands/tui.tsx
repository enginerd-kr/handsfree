import React from 'react';
import { render } from 'ink';
import type { Config } from '../config/schema.js';
import { createRuntime } from '../runtime.js';
import { App } from '../ui/tui/app.js';

export async function tui(config: Config, runId?: string): Promise<number> {
  const runtime = createRuntime({ config, runId });
  const instance = render(<App runtime={runtime} />);
  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    await runtime.close();
  }
}
