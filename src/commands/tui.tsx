import React from 'react';
import { render } from 'ink';
import type { Config } from '../config/schema.js';
import { createRuntime } from '../runtime.js';
import { App } from '../ui/tui/app.js';

export interface TuiOptions {
  runId?: string;
  /** The file the settings were read from, for `/config` to name. */
  configSource?: string;
}

export async function tui(config: Config, options: TuiOptions = {}): Promise<number> {
  const runtime = createRuntime({
    config,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.configSource === undefined ? {} : { configSource: options.configSource }),
  });
  const instance = render(<App runtime={runtime} />);
  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    await runtime.close();
  }
}
