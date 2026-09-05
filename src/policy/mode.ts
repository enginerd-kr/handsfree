import type { RuleOutcome } from '../config/schema.js';

/** Session permission handling: forward every request, or approve every request. */
export type PermissionMode = 'ask' | 'bypass';
export const MODES: readonly PermissionMode[] = ['ask', 'bypass'];

export function nextMode(mode: PermissionMode): PermissionMode {
  return mode === 'ask' ? 'bypass' : 'ask';
}

export function parsePermissionMode(text: string | undefined): PermissionMode | undefined {
  return (MODES as readonly string[]).includes(text ?? '') ? (text as PermissionMode) : undefined;
}

/** Legacy rule names remain useful audit context; only the session mode decides. */
export function applyMode<R extends { outcome: RuleOutcome; rule: string }>(mode: PermissionMode, ruling: R): R {
  return { ...ruling, outcome: mode === 'bypass' ? 'allow' : 'ask' };
}

export function modeAllows(mode: PermissionMode, _rule: string): boolean {
  return mode === 'bypass';
}

export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'ask every time',
  bypass: 'bypass permissions',
};

export const MODE_DESCRIPTION: Record<PermissionMode, string> = {
  ask: 'every permission request comes to you',
  bypass: 'every permission request is allowed',
};
