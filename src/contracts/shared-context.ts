import { z } from 'zod';
import { referenceSchema } from './reference.js';
import type { TaskStatus } from './task.js';

/** An explicit, immutable prefix of one collaboration's public conversation. */
export const SharedContextSchema = z.object({
  conversation: referenceSchema('conversation'),
  through: referenceSchema('record'),
});
export type SharedContextSelection = z.infer<typeof SharedContextSchema>;

/** Sources point to exact user requests/updates or saved task results. */
export type SharedContextEntry =
  | { event: 'open'; title: string; source: number }
  | { event: 'include'; conversation: number; source: number }
  | { event: 'reply'; conversation: number; source: number }
  | { event: 'note'; conversation: number; text: string };

export interface SharedMessage {
  record: string;
  source: string;
  author: string;
  role: 'user' | 'agent' | 'orchestrator';
  content: string;
  task?: string;
  status?: TaskStatus;
}
export interface SharedContextSnapshot extends SharedContextSelection {
  title: string;
  messages: SharedMessage[];
}
