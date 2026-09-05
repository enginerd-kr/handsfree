import { z } from 'zod';
import type { AgentJobs } from '../jobs.js';
import type { AgentTool } from './agent.js';
import { renderToolResult, toolError, type Tool, type ToolContext, type ToolResult } from './tool.js';
import { reference, referenceId, referenceSchema } from '../../../contracts/reference.js';
import { SharedContextSchema } from '../../../contracts/shared-context.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }),
  z.object({ operation: z.literal('poll'), jobId: referenceSchema('job') }),
  z.object({ operation: z.literal('wait'), jobIds: z.array(referenceSchema('job')).default([]) }),
  z.object({ operation: z.literal('cancel'), jobId: referenceSchema('job') }),
  z.object({ operation: z.literal('followup'), jobId: referenceSchema('job'), prompt: z.string().min(1),
    kind: z.enum(['answer', 'inspect', 'change']).optional(), context_from: z.array(referenceSchema('task')).optional(),
    shared_context: SharedContextSchema.nullable().optional() }),
]);

export class JobTool implements Tool<z.infer<typeof Input>> {
  readonly name = 'agent_job';
  readonly input = Input;
  constructor(private readonly jobs: AgentJobs, private readonly agent: AgentTool) {}
  describe(): string {
    return 'agent_job — manage background agent calls. {"operation":"list"}, {"operation":"poll","jobId":"job:1"}, {"operation":"wait","jobIds":["job:1","job:2"]}, {"operation":"cancel","jobId":"job:1"}, or {"operation":"followup","jobId":"job:1","prompt":"next instruction","kind":"answer","context_from":["task:3"]}. Empty jobIds waits for all. Wait returns early for a user update. Poll and wait observe existing jobs; they do not create additional worker replies. Followup requires a completed job and starts a new background call to the same recipients. Pass context_from explicitly for individual replies. For a shared-context job, followup also requires an explicit shared_context:{"conversation":"conversation:12","through":"record:24"}; choose the snapshot from shared_context.read or a returned conversation_head. Shared calls use a fresh session; other follow-ups reuse their session. Cancel interrupts the active task; followup is a new prompt after it settles.';
  }
  async run(input: z.infer<typeof Input>, ctx: ToolContext): Promise<ToolResult> {
    try {
      switch (input.operation) {
        case 'list': return { text: JSON.stringify(this.jobs.list().map(({ jobId, status, taskIds, input }) => ({ jobId: reference('job', jobId), status, taskIds: taskIds.map((id) => reference('task', id)), agent: input.agent }))) };
        case 'poll': return this.jobs.result(referenceId('job', input.jobId));
        case 'cancel': this.jobs.cancel(referenceId('job', input.jobId)); return { text: `Cancellation requested for ${input.jobId}. Wait for it to settle before following up.`,
          receipt: { status: 'pending', executed: true, created_tasks: [], job: input.jobId } };
        case 'wait': {
          const selected = input.jobIds.map((ref) => referenceId('job', ref));
          await this.jobs.wait(selected, ctx);
          const ids = selected.length ? selected : this.jobs.list().map((job) => job.jobId);
          const results = ids.map((id) => this.jobs.result(id));
          return { text: results.map(renderToolResult).join('\n\n') || 'No agent jobs.',
            receipt: { status: results.some((r) => r.receipt?.status === 'pending') ? 'pending' : results.some((r) => r.receipt?.status === 'error' || r.receipt?.status === 'cancelled') ? 'error' : 'ok',
              executed: true, created_tasks: [], observed_tasks: results.flatMap((r) => r.receipt?.observed_tasks ?? []) },
            outcomes: results.flatMap((result) => [...(result.outcomes ?? []), ...(result.outcome ? [result.outcome] : [])]) };
        }
        case 'followup': {
          const previous = this.jobs.get(referenceId('job', input.jobId));
          if (previous.status === 'running') return toolError('job_running', `${input.jobId} is still running. Wait or cancel before following up.`);
          if (previous.input.shared_context && input.shared_context === undefined) return toolError('shared_context_required',
            'Choose an explicit shared_context snapshot for this follow-up. Read the conversation or use a returned conversation_head; a previous worker session is not shared context. Use shared_context:null only to make an ordinary call outside the collaboration.');
          return this.agent.run({ agent: previous.input.agent, model: previous.input.model,
            kind: input.kind ?? previous.input.kind, prompt: input.prompt,
            ...(input.context_from ? { context_from: input.context_from } : {}),
            ...(input.shared_context !== undefined ? { shared_context: input.shared_context } : {}), background: true }, ctx);
        }
      }
    } catch (err) { return toolError('agent_job_error', `Agent job error: ${(err as Error).message}`, false, this.jobs.list().map((job) => reference('job', job.jobId))); }
  }
}
