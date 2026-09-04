import { describe, expect, it } from 'vitest';
import { applyMode, modeAllows, nextMode, parsePermissionMode } from './mode.js';

describe('permission mode', () => {
  it('cycles ask → acceptEdits → bypass → ask', () => {
    expect(nextMode('ask')).toBe('acceptEdits');
    expect(nextMode('acceptEdits')).toBe('bypass');
    expect(nextMode('bypass')).toBe('ask');
  });

  it('reads a flag value, and nothing else', () => {
    expect(parsePermissionMode('bypass')).toBe('bypass');
    expect(parsePermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(parsePermissionMode('yolo')).toBeUndefined();
    expect(parsePermissionMode(undefined)).toBeUndefined();
  });

  it('leaves every ruling alone in ask', () => {
    for (const outcome of ['allow', 'ask', 'deny'] as const) {
      expect(applyMode('ask', { outcome, rule: 'exec.otherwise' }).outcome).toBe(outcome);
    }
  });

  it('accepts a file question in acceptEdits, and keeps a command one', () => {
    expect(applyMode('acceptEdits', { outcome: 'ask', rule: 'fs.write' }).outcome).toBe('allow');
    expect(applyMode('acceptEdits', { outcome: 'ask', rule: 'tool.write' }).outcome).toBe('allow');
    expect(applyMode('acceptEdits', { outcome: 'ask', rule: 'exec.otherwise' }).outcome).toBe('ask');
    expect(applyMode('acceptEdits', { outcome: 'ask', rule: 'tool.opaqueCommand' }).outcome).toBe('ask');
    // A denial stays one: the mode answers questions, it does not rewrite rules.
    expect(applyMode('acceptEdits', { outcome: 'deny', rule: 'fs.write.outside' }).outcome).toBe('deny');
    // A standing approval is still a person's call, even for an edit.
    expect(modeAllows('acceptEdits', 'tool.sessionWideOnly')).toBe(false);
  });

  it('lifts asks and denials alike in bypass, save what is not policy', () => {
    expect(applyMode('bypass', { outcome: 'ask', rule: 'exec.otherwise' }).outcome).toBe('allow');
    expect(applyMode('bypass', { outcome: 'deny', rule: 'fs.write.outside' }).outcome).toBe('allow');
    expect(applyMode('bypass', { outcome: 'deny', rule: 'exec.disabled' }).outcome).toBe('allow');
    expect(modeAllows('bypass', 'tool.sessionWideOnly')).toBe(true);
    expect(modeAllows('bypass', 'tool.switchMode')).toBe(false);
    expect(applyMode('bypass', { outcome: 'deny', rule: 'exec.empty' }).outcome).toBe('deny');
    expect(applyMode('bypass', { outcome: 'deny', rule: 'exec.nullByte' }).outcome).toBe('deny');
  });

  it('keeps the rule name on a lifted ruling', () => {
    expect(applyMode('bypass', { outcome: 'deny', rule: 'exec.disabled', reason: 'off' })).toEqual({
      outcome: 'allow',
      rule: 'exec.disabled',
      reason: 'off',
    });
  });
});
