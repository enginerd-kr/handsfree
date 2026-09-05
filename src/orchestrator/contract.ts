import { z } from 'zod';
import { TokenBudgetSchema } from '../config/schema.js';

export const TaskRequestSchema = z.object({
  task: z.string().trim().min(1),
  kind: z.enum(['answer', 'inspect', 'change']).default('change'),
  constraints: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  files: z.array(z.string().min(1)).default([]),
  /** Earlier task blockers/decisions superseded when this task succeeds. */
  resolves: z.array(z.number().int().positive()).default([]),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  budget: TokenBudgetSchema.optional(),
  /** Same key + same request returns the existing result, including across restart. */
  requestId: z.string().min(1).max(128).optional(),
}).strict().refine((request) => !request.sessionId || !!request.agent, 'sessionId requires agent');
export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type TaskRequestInput = z.input<typeof TaskRequestSchema>;

export const TaskResultSchema = z.object({
  taskId: z.number().int().positive(),
  runId: z.string(),
  agent: z.string(),
  status: z.enum(['done', 'blocked', 'incomplete', 'refused', 'cancelled', 'error', 'budget_exceeded']),
  summary: z.string(),
  artifacts: z.array(z.string()),
  blockers: z.array(z.string()),
  resultRef: z.string(),
  verification: z.object({ source: z.enum(['agent_report', 'unreported']), detail: z.string() }),
  usage: z.object({
    tokens: z.number(), frontierTokens: z.number(), estimated: z.boolean(), costUsd: z.number().optional(),
  }).optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const BatchRequestSchema = z.object({
  tasks: z.array(z.object({ id: z.string().min(1), dependsOn: z.array(z.string()).default([]), request: TaskRequestSchema }).strict()).min(1).max(64),
}).strict();
export type BatchRequest = z.input<typeof BatchRequestSchema>;

export function taskBrief(request: TaskRequest): string {
  return [request.task,
    ...(request.constraints.length ? [`Constraints (must preserve):\n${request.constraints.map((s) => `- ${s}`).join('\n')}`] : []),
    ...(request.acceptanceCriteria.length ? [`Done when:\n${request.acceptanceCriteria.map((s) => `- ${s}`).join('\n')}`] : []),
    ...(request.files.length ? [`Relevant paths:\n${request.files.join('\n')}`] : []),
  ].join('\n\n');
}
