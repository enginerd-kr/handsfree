import React from 'react';
import { render } from 'ink';
import type { Config } from '../config/schema.js';
import type { ConfigLocation } from '../config/load.js';
import { createRuntime } from '../runtime.js';
import { App } from '../ui/tui/app.js';

export interface TuiOptions {
  runId?: string;
  /** The files the settings were read from, strongest first, for `/config` to name. */
  configSources?: readonly ConfigLocation[];
}

export async function tui(config: Config, options: TuiOptions = {}): Promise<number> {
  const runtime = createRuntime({
    config,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.configSources === undefined ? {} : { configSources: options.configSources }),
  });
  const instance = render(<App runtime={runtime} />);
  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    await runtime.close();
  }
}
