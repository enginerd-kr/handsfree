import { z } from 'zod';

export type ReferenceKind = 'task' | 'record' | 'job' | 'conversation';

/** Model-facing addresses are namespaced; persisted IDs remain numeric. */
export function reference(kind: ReferenceKind, id: number): string { return `${kind}:${id}`; }

export function referenceId(kind: ReferenceKind, value: string): number {
  const match = new RegExp(`^${kind}:([1-9][0-9]*)$`).exec(value);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id)) throw new Error(`Expected a ${kind} reference such as "${kind}:1"; received ${JSON.stringify(value)}.`);
  return id;
}

export function referenceSchema(kind: ReferenceKind) {
  return z.string().regex(new RegExp(`^${kind}:[1-9][0-9]*$`), `Use a ${kind} reference such as "${kind}:1", not a bare number or another reference kind.`)
    .refine((value) => Number.isSafeInteger(Number(value.slice(kind.length + 1))), 'Reference number is outside the supported integer range.');
}
