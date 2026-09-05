import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { pathsFromRawInput } from '../../policy/engine.js';
import type { PolicyRequest } from '../../policy/types.js';
import type { HostContext } from './context.js';

/** Forward the adapter's permission request once, then return its selected approval scope. */
export function createPermissionHandler(host: HostContext) {
  return async (
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> => {
    const call = params.toolCall;
    // Adapters are inconsistent about `locations`: claude-code-acp sends none at
    // all and puts the file in `rawInput`. Show both sources to the user.
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
    const once = pick(params.options, 'allow_once');
    const approval = once ?? pick(params.options, 'allow_always');
    if (!approval) return { outcome: { outcome: 'cancelled' } };
    if (!once) request.approvalLabel = approval.name;

    // Ask once about exactly the scope the adapter can grant.
    const decision = once
      ? await host.policy.resolve(request, ask)
      : await host.policy.confirm(request, {
          rule: 'tool.sessionWideOnly',
          reason: `${host.agentId} offers "${approval.name}" for the whole session, with no single-use approval`,
        }, ask);
    if (decision.verdict === 'allow') {
      return { outcome: { outcome: 'selected', optionId: approval.optionId } };
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
