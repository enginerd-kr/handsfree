const runtimes = new Set<() => Promise<void>>();

/** Runtime ownership is shared by every CLI mode, including served sessions. */
export function registerShutdown(close: () => Promise<void>): () => void {
  runtimes.add(close);
  return () => { runtimes.delete(close); };
}

/** Installed by the CLI only; importing the runtime does not intercept signals. */
export function installShutdownHandlers(): void {
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    // Keep the handlers during cleanup so a repeated signal cannot interrupt
    // it and strand the detached ACP process groups.
    void drain().then(() => {
      process.exit(code);
    });
  };
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  process.on('SIGHUP', () => stop(129));
}

async function drain(): Promise<void> {
  // An editor can open a served session while an earlier one is closing.
  // Include any runtimes registered during cleanup before leaving.
  while (runtimes.size > 0) {
    const closing = [...runtimes];
    runtimes.clear();
    await Promise.allSettled(closing.map((close) => close()));
  }
}
