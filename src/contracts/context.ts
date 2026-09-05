import type { LoopReview } from './review.js';

export type ContextKind = 'objective' | 'constraint' | 'decision' | 'finding' | 'open';
export type ContextEntry =
  | { event: 'start'; request: string }
  | { event: 'update'; turn: number; request: string }
  | { event: 'mode'; mode: 'plan' | 'execute' }
  | { event: 'plan'; turn: number; text: string }
  | { event: 'checkpoint'; turn: number; messages: { role: 'system' | 'user' | 'assistant'; content: string }[] }
  | { event: 'step'; turn: number; action: string }
  | { event: 'review'; turn: number; state: LoopReview; sources: number[] }
  | { event: 'complete'; turn: number; item: string; sources: number[] }
  | { event: 'evidence'; turn: number; key: string; text: string }
  | { event: 'finish'; turn: number; status: 'reported' | 'cancelled' | 'limited' | 'error'; reply: string }
  | { event: 'note'; turn: number; key: string; kind: ContextKind; text: string; sources: number[]; active: boolean };
