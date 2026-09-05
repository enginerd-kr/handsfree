import { z } from 'zod';
import type { Executor } from '../orchestrator/executor.js';
import type { Tool } from './tool.js';

export class ResultTool implements Tool<{ taskId: number; offset: number }> {
  readonly name = 'task_result';
  readonly input = z.object({ taskId: z.number().int().positive(), offset: z.number().int().nonnegative().default(0) });
  constructor(private readonly executor: Executor, private readonly maxChars: number) {}
  describe(): string { return 'task_result — retrieve missing task details only when the short report is insufficient. Input: {"taskId":1,"offset":0}. Follow nextOffset for another page.'; }
  async run({ taskId, offset }: { taskId: number; offset: number }) {
    const page = this.executor.readResult(taskId, offset, this.maxChars - 80);
    return { text: `${page.text}${page.nextOffset === undefined ? '' : `\nnextOffset: ${page.nextOffset}`}` };
  }
}
