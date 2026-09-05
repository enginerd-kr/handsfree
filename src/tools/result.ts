import { z } from 'zod';
import type { Executor } from '../orchestrator/executor.js';
import type { Tool } from './tool.js';

export class ResultTool implements Tool<{ taskId: number; offset: number }> {
  readonly name = 'task_result';
  readonly input = z.object({ taskId: z.number().int().positive(), offset: z.number().int().nonnegative().default(0) });
  constructor(private readonly executor: Executor, private readonly maxChars: number) {}
  describe(): string { return 'task_result — read a completed task\'s recorded reply and details to explain, compare or inspect previous results without contacting the agent again. Input: {"taskId":1,"offset":0}. Use the taskId from Task N or RESULT SOURCES, not a context record number. Follow nextOffset for another page. If a lookup fails, correct the address and read the saved result; do not rerun the worker.'; }
  async run({ taskId, offset }: { taskId: number; offset: number }) {
    try {
      const page = this.executor.readResult(taskId, offset, this.maxChars - 80);
      return { text: `${page.text}${page.nextOffset === undefined ? '' : `\nnextOffset: ${page.nextOffset}`}`, completedWork: true };
    } catch (error) {
      // A failed read is feedback for the next planner step, not a failed
      // worker or a reason to abandon the entire conversation turn.
      return { text: `Task result error: ${(error as Error).message}`.slice(0, this.maxChars), completedWork: false };
    }
  }
}
