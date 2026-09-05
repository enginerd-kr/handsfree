/** Fair workspace lock: inspections may overlap; changes exclude every other task. */
export class TaskScheduler {
  private active = new Map<string, boolean>();
  private queue: { agent: string; write: boolean; signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; cancel: () => void }[] = [];
  constructor(private readonly parallel: number) {}

  acquire(agent: string, write: boolean, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('Cancelled while waiting for execution'));
    return new Promise((resolve, reject) => {
      const item = { agent, write, signal, resolve, reject, cancel: () => {} };
      item.cancel = () => {
        this.queue = this.queue.filter((entry) => entry !== item);
        reject(new Error('Cancelled while waiting for execution'));
        this.drain();
      };
      signal.addEventListener('abort', item.cancel, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }

  private drain(): void {
    for (let at = 0; at < this.queue.length;) {
      const item = this.queue[at]!;
      if (this.active.size >= this.parallel || [...this.active.values()].some(Boolean)) return;
      if (item.write && this.active.size > 0) return;
      if (this.active.has(item.agent)) { at++; continue; }
      this.queue.splice(at, 1);
      item.signal.removeEventListener('abort', item.cancel);
      this.active.set(item.agent, item.write);
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.active.delete(item.agent);
        this.drain();
      });
      if (item.write) return;
    }
  }
}

const workspaces = new Map<string, { scheduler: TaskScheduler; owners: number }>();

/** ACP clients may open several runtimes on one checkout in the same host. */
export function workspaceScheduler(dir: string, parallel: number): { scheduler: TaskScheduler; release(): void } {
  let shared = workspaces.get(dir);
  if (!shared) { shared = { scheduler: new TaskScheduler(parallel), owners: 0 }; workspaces.set(dir, shared); }
  shared.owners++;
  let released = false;
  return { scheduler: shared.scheduler, release: () => {
    if (released) return;
    released = true;
    if (--shared.owners === 0) workspaces.delete(dir);
  } };
}
