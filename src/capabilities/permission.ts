import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { pathsFromRawInput } from '../policy/engine.js';
import type { PolicyRequest } from '../policy/types.js';
import type { HostContext } from './context.js';

/**
 * Gate A. An agent that wants to do something through its own tools has to ask
 * here first, and this is the only place in handsfree that can say yes.
 *
 * Two invariants shape the answer:
 *   - only `allow_once` is ever selected, because a standing approval is a
 *     decision about future work we have not seen;
 *   - where the agent offers no way to say "just this once", widening it is a
 *     decision only a person may make, so the person is asked in as many words
 *     — and with nobody there the request is cancelled rather than widened.
 */
export function createPermissionHandler(host: HostContext) {
  return async (
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> => {
    const call = params.toolCall;
    // Adapters are inconsistent about `locations`: claude-code-acp sends none at
    // all and puts the file in `rawInput`. Both are gathered, so the workspace
    // boundary applies to every path the request actually names.
    const locations = [
      ...(call.locations ?? []).map((location) => location.path),
      ...pathsFromRawInput(call.rawInput ?? null),
    ].filter(Boolean);

    const request: PolicyRequest = {
      kind: 'tool',
      agentId: host.agentId,
      sessionId: params.sessionId,
      toolKind: call.kind ?? null,
      title: call.title ?? call.name ?? 'unnamed tool call',
      locations: [...new Set(locations)],
      rawInput: call.rawInput ?? null,
    };
    const ask = { ...(signal ? { signal } : {}) };
    const decision = await host.policy.resolve(request, ask);

    if (decision.verdict === 'allow') {
      const once = pick(params.options, 'allow_once');
      if (once) return { outcome: { outcome: 'selected', optionId: once.optionId } };

      // No single-use approval on offer. The rules cleared the operation, so
      // the only question left is whether to hand over the standing approval
      // the agent asked for — which is a person's call, never ours.
      const always = pick(params.options, 'allow_always');
      if (always) {
        const widened = await host.policy.confirm(
          request,
          {
            rule: 'tool.sessionWideOnly',
            reason: `${host.agentId} offers no single-use approval — approving means approving this for the whole session`,
          },
          ask,
        );
        if (widened.verdict === 'allow') {
          host.transcript.append({
            type: 'note',
            level: 'warn',
            text:
              `approved "${request.title}" for the rest of ${host.agentId}'s session — ` +
              'it offered no way to approve just this once.',
          });
          return { outcome: { outcome: 'selected', optionId: always.optionId } };
        }
        return { outcome: { outcome: 'cancelled' } };
      }

      host.transcript.append({
        type: 'note',
        level: 'warn',
        text:
          `${host.agentId} offered no way to approve "${request.title}", ` +
          'so it was cancelled.',
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
