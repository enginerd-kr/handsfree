import { z } from 'zod';
import type { Executor } from '../../execution/executor.js';
import { toolError, type Tool, type ToolResult } from './tool.js';
import { referenceId, referenceSchema } from '../../../contracts/reference.js';

export class ResultTool implements Tool<{ taskId: string; offset: number; maxChars?: number | undefined }> {
  readonly name = 'task_result';
  readonly input = z.object({ taskId: referenceSchema('task'), offset: z.number().int().nonnegative().default(0), maxChars: z.number().int().positive().optional() });
  constructor(private readonly executor: Executor, private readonly taskRefs: () => string[] = () => []) {}
  describe(): string { return 'task_result — retrieve a saved reply without contacting the agent again. Input: {"taskId":"task:1","offset":0,"maxChars":8000}. Only task: references are accepted. Follow nextOffset for another page; omit maxChars for the full result. This observes an existing task and creates no new task or worker reply. Write your own summary in a later agent prompt, or use agent.context_from to forward exact replies directly.'; }
  async run({ taskId, offset, maxChars }: { taskId: string; offset: number; maxChars?: number | undefined }): Promise<ToolResult> {
    try {
      const page = this.executor.readResult(referenceId('task', taskId), offset, maxChars);
      return { text: `${page.text}${page.nextOffset === undefined ? '' : `\nnextOffset: ${page.nextOffset}`}`,
        receipt: { status: 'ok', executed: true, created_tasks: [], observed_tasks: [taskId] } };
    } catch (error) {
      return toolError('invalid_task_reference', `Cannot read task result: ${(error as Error).message}`, false, this.taskRefs());
    }
  }
}
