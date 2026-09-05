import type { LoopReview } from './review.js';

export type ContextKind = 'objective' | 'constraint' | 'decision' | 'finding' | 'open';
export type ContextEntry =
  | { event: 'start'; request: string }
  | { event: 'step'; turn: number; action: string }
  | { event: 'review'; turn: number; state: LoopReview; sources: number[] }
  | { event: 'complete'; turn: number; item: string; sources: number[] }
  | { event: 'evidence'; turn: number; key: string; text: string }
  | { event: 'finish'; turn: number; status: 'reported' | 'cancelled' | 'limited' | 'error'; reply: string }
  | { event: 'note'; turn: number; key: string; kind: ContextKind; text: string; sources: number[]; active: boolean };
