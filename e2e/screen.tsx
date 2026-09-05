import { EventEmitter } from 'node:events';
import React from 'react';
import { render as inkRender } from 'ink';
import { App } from '../src/ui/tui/app.js';
import type { Runtime } from '../src/runtime.js';

/**
 * A terminal that only remembers what was drawn on it. ink writes whole frames
 * here — `debug: true` turns off the cursor arithmetic a real terminal needs —
 * so the last write is the screen, ANSI and all.
 */
class Screen extends EventEmitter {
  frames: string[] = [];
  last: string | undefined;
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  write = (frame: string): void => {
    this.frames.push(frame);
    this.last = frame;
  };
}

/** A keyboard nothing is typed on unless a shot asks for it. */
class Keyboard extends EventEmitter {
  isTTY = true;
  private pending: string | null = null;
  write = (data: string): void => {
    this.pending = data;
    this.emit('readable');
    this.emit('data', data);
  };
  read = (): string | null => {
    const data = this.pending;
    this.pending = null;
    return data;
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

export interface Session {
  /** The screen as it stands, ANSI escapes intact. */
  frame(): string;
  /** The screen with every escape stripped, for anchoring on. */
  plain(): string;
  /** Types into the prompt, a keypress at a time, the way a person would. */
  type(text: string): Promise<void>;
  /** Sends one key sequence whole — an arrow, a control code, a mouse report. */
  press(sequence: string): Promise<void>;
  /** Waits until the drawn frame contains `text`, or gives up saying so. */
  until(text: string, timeoutMs?: number): Promise<string>;
  /** Lets timers and promises run for a beat. */
  settle(ms?: number): Promise<void>;
  close(): void;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

export const strip = (text: string): string => text.replace(ANSI, '');

/** Opens the real TUI on a screen of the given size. */
export function open(runtime: Runtime, columns = 96, rows = 40, settingsHome?: string): Session {
  const screen = new Screen(columns, rows);
  const keyboard = new Keyboard();
  const instance = inkRender(<App runtime={runtime} settingsHome={settingsHome} />, {
    stdout: screen as unknown as NodeJS.WriteStream,
    stderr: screen as unknown as NodeJS.WriteStream,
    stdin: keyboard as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    frame: () => screen.last ?? '',
    plain: () => strip(screen.last ?? ''),
    async type(text) {
      for (const char of text) {
        keyboard.write(char);
        await settle(15);
      }
    },
    async press(sequence) {
      keyboard.write(sequence);
      await settle(40);
    },
    async until(text, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = screen.last ?? '';
        if (strip(current).includes(text)) return current;
        if (Date.now() > deadline) {
          throw new Error(`never drew "${text}". Last frame:\n${strip(current)}`);
        }
        await settle(20);
      }
    },
    settle,
    close() {
      instance.unmount();
      instance.cleanup();
    },
  };
}
