import React from 'react';
import { render } from 'ink';
import type { Config } from '../config/schema.js';
import type { ConfigLocation } from '../config/load.js';
import { createRuntime } from '../runtime.js';
import { App } from '../ui/tui/app.js';

export interface TuiOptions {
  runId?: string;
  /** Work in this existing directory instead of a fresh sandbox. */
  attachTo?: string;
  /** The user settings source, for `/config` to name. */
  configSources?: readonly ConfigLocation[];
}

export async function tui(config: Config, options: TuiOptions = {}): Promise<number> {
  const runtime = createRuntime({
    config,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.attachTo === undefined ? {} : { attachTo: options.attachTo }),
    ...(options.configSources === undefined ? {} : { configSources: options.configSources }),
  });
  // The kitty keyboard protocol, where the terminal offers it: it is what
  // tells shift+enter apart from enter, which the legacy encoding cannot.
  // Ink asks the terminal and falls back quietly where nothing answers.
  const instance = render(<App runtime={runtime} />, { kittyKeyboard: { mode: 'auto' } });
  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    await runtime.close();
  }
}
