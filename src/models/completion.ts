/** Provider-independent termination metadata; an adapter never guesses completion from prose. */
export type ModelFinish = 'complete' | 'truncated' | 'refused' | 'cancelled' | 'tool_use' | 'unknown';
export type ModelFailure = 'context' | 'authentication' | 'refused' | 'truncated' | 'transport' | 'format';

export class ModelError extends Error {
  constructor(readonly kind: ModelFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelError';
  }
}

export function modelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  const detail = error as { status?: number; code?: string; message?: string } | undefined;
  const message = detail?.message ?? String(error);
  const hint = `${detail?.code ?? ''} ${message}`;
  const kind: ModelFailure = detail?.status === 401 || detail?.status === 403 ? 'authentication'
    : /context[_ ](?:length|window|limit)|maximum context|prompt (?:is )?too long|too many input tokens|exceeds.*context/i.test(hint) ? 'context'
    : 'transport';
  return new ModelError(kind, message, { cause: error });
}

export function modelFinish(reason: string | null | undefined): ModelFinish {
  switch (reason) {
    case 'stop': case 'end_turn': return 'complete';
    case 'length': case 'max_tokens': case 'max_turn_requests': return 'truncated';
    case 'content_filter': case 'refusal': return 'refused';
    case 'cancelled': return 'cancelled';
    case 'tool_calls': case 'function_call': return 'tool_use';
    default: return 'unknown';
  }
}
