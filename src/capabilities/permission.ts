import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { HostContext } from './context.js';

/**
 * Gate A. An agent that wants to do something through its own tools has to ask
 * here first, and this is the only place in handsfree that can say yes.
 *
 * Two invariants shape the answer:
 *   - only `allow_once` is ever selected, because a standing approval is a
 *     decision about future work we have not seen;
 *   - if the agent offers no way to say "just this once", the request is
 *     cancelled rather than widened to fit.
 */
export function createPermissionHandler(host: HostContext) {
  return async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    const call = params.toolCall;
    const decision = await host.policy.resolve({
      kind: 'tool',
      agentId: host.agentId,
      sessionId: params.sessionId,
      toolKind: call.kind ?? null,
      title: call.title ?? call.name ?? 'unnamed tool call',
      locations: (call.locations ?? []).map((location) => location.path).filter(Boolean),
      rawInput: call.rawInput ?? null,
    });

    if (decision.verdict === 'allow') {
      const option = pick(params.options, 'allow_once');
      if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
      host.transcript.append({
        type: 'note',
        level: 'warn',
        text:
          `${host.agentId} offered no single-use approval for "${call.title ?? 'tool call'}", ` +
          'so it was cancelled rather than approved for the whole session.',
      });
      return { outcome: { outcome: 'cancelled' } };
    }

    const option = pick(params.options, 'reject_once');
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  };
}

function pick(
  options: readonly PermissionOption[],
  kind: PermissionOption['kind'],
): PermissionOption | undefined {
  return options.find((option) => option.kind === kind);
}
