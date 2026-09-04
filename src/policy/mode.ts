import type { RuleOutcome } from '../config/schema.js';

/**
 * How much of what the rules cannot settle is put to a person. Runtime state
 * for one session, cycled from the keyboard: it is never read from a config
 * file and never written to one, and the rules themselves are left exactly as
 * the config wrote them — a mode changes what happens to their answer.
 *
 *   - `ask`          every question comes to a person, every time;
 *   - `acceptEdits`  a question about a file inside the workspace is a yes,
 *                    a question about a command still comes to a person;
 *   - `bypass`       everything is a yes, including what the rules refused.
 */
export type PermissionMode = 'ask' | 'acceptEdits' | 'bypass';

/** The order Shift+Tab walks. */
export const MODES: readonly PermissionMode[] = ['ask', 'acceptEdits', 'bypass'];

export function nextMode(mode: PermissionMode): PermissionMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
}

/** A mode as a flag spells it, or nothing when the text is not one. */
export function parsePermissionMode(text: string | undefined): PermissionMode | undefined {
  return (MODES as readonly string[]).includes(text ?? '') ? (text as PermissionMode) : undefined;
}

/**
 * The rules that judge a file inside the workspace — what `acceptEdits` says
 * yes to. A positive list, so a rule added later is a question until someone
 * decides it is an edit. `tool.unknownTarget` is here because it is only ever
 * raised for a tool of a file kind that named no file.
 */
const FILE_RULES: ReadonlySet<string> = new Set([
  'fs.read',
  'fs.write',
  'tool.read',
  'tool.write',
  'tool.unknownTarget',
]);

/**
 * What even `bypass` leaves refused. An agent asking to change its own
 * approval mode is refused because the mode is handsfree's — a bypass that
 * handed it over would be the end of the audit trail, not a wider one. The
 * other two are not policy at all: a command with nothing to run, or a null
 * byte in an argument, fails at spawn whatever anyone decided.
 */
const NEVER_LIFTED: ReadonlySet<string> = new Set(['tool.switchMode', 'exec.empty', 'exec.nullByte']);

/** The rules' answer, as the mode leaves it. The rule name is kept: it says what was overridden. */
export function applyMode<R extends { outcome: RuleOutcome; rule: string }>(
  mode: PermissionMode,
  ruling: R,
): R {
  if (mode === 'ask' || ruling.outcome === 'allow') return ruling;
  if (mode === 'bypass') {
    return NEVER_LIFTED.has(ruling.rule) ? ruling : { ...ruling, outcome: 'allow' };
  }
  return ruling.outcome === 'ask' && FILE_RULES.has(ruling.rule)
    ? { ...ruling, outcome: 'allow' }
    : ruling;
}

/** Whether a question already put to a person would not have been asked under `mode`. */
export function modeAllows(mode: PermissionMode, rule: string): boolean {
  return applyMode(mode, { outcome: 'ask' as RuleOutcome, rule }).outcome === 'allow';
}

/** One wording for the footer, the audit row and `/config`. */
export const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'ask every time',
  acceptEdits: 'accept edits',
  bypass: 'bypass permissions',
};

/** The sentence under each label, where a mode picker has room for one. */
export const MODE_DESCRIPTION: Record<PermissionMode, string> = {
  ask: 'every question comes to you, every time',
  acceptEdits: 'files in the workspace go through, commands still ask',
  bypass: 'everything is allowed, whatever the rules say',
};
