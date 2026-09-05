import { z } from 'zod';
import type { Executor } from '../../execution/executor.js';
import type { Tool } from './tool.js';

export class ResultTool implements Tool<{ taskId: number; offset: number; maxChars?: number | undefined }> {
  readonly name = 'task_result';
  readonly input = z.object({ taskId: z.number().int().positive(), offset: z.number().int().nonnegative().default(0), maxChars: z.number().int().positive().optional() });
  constructor(private readonly executor: Executor) {}
  describe(): string { return 'task_result — read a completed task\'s recorded reply and details to explain, compare or inspect previous results without contacting the agent again. Input: {"taskId":1,"offset":0,"maxChars":8000}. Follow nextOffset for another page; omit maxChars for the full result. Write your own summary in a later agent prompt, or use agent.context_from to forward exact replies directly.'; }
  async run({ taskId, offset, maxChars }: { taskId: number; offset: number; maxChars?: number | undefined }) {
    try {
      const page = this.executor.readResult(taskId, offset, maxChars);
      return { text: `${page.text}${page.nextOffset === undefined ? '' : `\nnextOffset: ${page.nextOffset}`}` };
    } catch (error) {
      return { text: `Cannot read task result: ${(error as Error).message}` };
    }
  }
}
