import { z } from 'zod';

/** A concise work-state checkpoint, not a chain of private reasoning. */
export const ReviewSchema = z.object({
  objective: z.string().min(1).max(500),
  constraints: z.array(z.string().min(1).max(300)).max(8),
  completed: z.array(z.string().min(1).max(300)).max(8),
  remaining: z.array(z.string().min(1).max(300)).max(8),
  /** Index into remaining; -1 for a direct reply or an unassigned context read. */
  next: z.number().int().min(-1).max(7),
  blocker: z.string().max(500),
});
export type LoopReview = z.infer<typeof ReviewSchema>;

export function nextItem(review: LoopReview): string { return review.remaining[review.next] ?? ''; }
