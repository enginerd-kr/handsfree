import React from 'react';
import { render } from 'ink';
import type { Config } from '../config/schema.js';
import { App } from './App.js';

export async function startTui(config: Config): Promise<void> {
  const { waitUntilExit } = render(<App config={config} />);
  await waitUntilExit();
}
