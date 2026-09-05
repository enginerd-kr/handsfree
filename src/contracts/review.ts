import { z } from 'zod';

/** An optional progress note written by the orchestrator, never an execution gate. */
export const ReviewSchema = z.object({
  objective: z.string().min(1),
  constraints: z.array(z.string().min(1)),
  completed: z.array(z.string().min(1)),
  remaining: z.array(z.string().min(1)),
  /** Index into remaining; -1 for a direct reply or an unassigned context read. */
  next: z.number().int().min(-1),
  blocker: z.string(),
});
export type LoopReview = z.infer<typeof ReviewSchema>;
