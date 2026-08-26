import React from 'react';
import { render } from 'ink';
import type { Config } from '../config/schema.js';
import { App } from './App.js';

export async function startTui(config: Config): Promise<void> {
  // The alternate screen is what lets the layout own the full window: the prompt
  // sits on the bottom row and the transcript scrolls above it, and the shell you
  // launched from comes back untouched on exit. Every run is on disk in the run
  // dir, so nothing is lost by keeping it out of the terminal's scrollback.
  const { waitUntilExit } = render(<App config={config} />, { alternateScreen: true });
  await waitUntilExit();
}
