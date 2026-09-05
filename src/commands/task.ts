import { createRuntime, type Runtime, type RuntimeOptions } from '../runtime.js';
import { TaskRequestSchema } from '../contracts/task.js';
import { stdinSeat } from '../ui/stdin-seat.js';

export async function task(json: string, options: RuntimeOptions, write: (line: string) => void): Promise<number> {
  let runtime: Runtime | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const request = TaskRequestSchema.parse(JSON.parse(json));
    runtime = createRuntime({ ...options, escalator: options.escalator ?? stdinSeat() });
    const result = await runtime.executor.execute(request, controller.signal);
    write(JSON.stringify(result));
    return result.status === 'done' ? 0 : 1;
  } catch (error) {
    write(JSON.stringify({ status: controller.signal.aborted ? 'cancelled' : 'error', summary: (error as Error).message }));
    return 1;
  } finally { process.off('SIGINT', stop); await runtime?.close(); }
}
