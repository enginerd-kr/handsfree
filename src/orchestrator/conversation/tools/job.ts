import { z } from 'zod';
import type { AgentJobs } from '../jobs.js';
import type { AgentTool } from './agent.js';
import type { Tool, ToolContext, ToolResult } from './tool.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }),
  z.object({ operation: z.literal('poll'), jobId: z.number().int().positive() }),
  z.object({ operation: z.literal('wait'), jobIds: z.array(z.number().int().positive()).default([]) }),
  z.object({ operation: z.literal('cancel'), jobId: z.number().int().positive() }),
  z.object({ operation: z.literal('followup'), jobId: z.number().int().positive(), prompt: z.string().min(1),
    kind: z.enum(['answer', 'inspect', 'change']).optional(), context_from: z.array(z.number().int().positive()).optional() }),
]);

export class JobTool implements Tool<z.infer<typeof Input>> {
  readonly name = 'agent_job';
  readonly input = Input;
  constructor(private readonly jobs: AgentJobs, private readonly agent: AgentTool) {}
  describe(): string {
    return 'agent_job — manage background agent calls. {"operation":"list"}, {"operation":"poll","jobId":1}, {"operation":"wait","jobIds":[1,2]}, {"operation":"cancel","jobId":1}, or {"operation":"followup","jobId":1,"prompt":"next instruction","kind":"answer","context_from":[3]}. Empty jobIds waits for all. Wait returns early for a user update. Followup requires a completed job, starts a new background call to the same recipients and preserves their own session history; pass context_from explicitly for other source replies. Cancel interrupts the active task; followup is a new prompt after it settles.';
  }
  async run(input: z.infer<typeof Input>, ctx: ToolContext): Promise<ToolResult> {
    try {
      switch (input.operation) {
        case 'list': return { text: JSON.stringify(this.jobs.list().map(({ jobId, status, taskIds, input }) => ({ jobId, status, taskIds, agent: input.agent }))) };
        case 'poll': return this.jobs.result(input.jobId);
        case 'cancel': this.jobs.cancel(input.jobId); return { text: `Cancellation requested for job ${input.jobId}. Wait for it to settle before following up.` };
        case 'wait': {
          await this.jobs.wait(input.jobIds, ctx);
          const ids = input.jobIds.length ? input.jobIds : this.jobs.list().map((job) => job.jobId);
          const results = ids.map((id) => this.jobs.result(id));
          return { text: results.map((result) => result.text).join('\n\n') || 'No agent jobs.',
            outcomes: results.flatMap((result) => [...(result.outcomes ?? []), ...(result.outcome ? [result.outcome] : [])]) };
        }
        case 'followup': {
          const previous = this.jobs.get(input.jobId);
          if (previous.status === 'running') return { text: `Job ${input.jobId} is still running. Wait or cancel before following up.` };
          return this.agent.run({ agent: previous.input.agent, model: previous.input.model,
            kind: input.kind ?? previous.input.kind, prompt: input.prompt,
            ...(input.context_from ? { context_from: input.context_from } : {}), background: true }, ctx);
        }
      }
    } catch (err) { return { text: `Agent job error: ${(err as Error).message}` }; }
  }
}
