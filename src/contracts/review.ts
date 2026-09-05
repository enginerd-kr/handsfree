import { z } from 'zod';

/** A concise work-state checkpoint, not a chain of private reasoning. */
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

export function nextItem(review: LoopReview): string { return review.remaining[review.next] ?? ''; }
