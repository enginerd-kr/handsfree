import { describe, expect, it } from 'vitest';
import { applyMode, modeAllows, nextMode, parsePermissionMode } from './mode.js';

describe('permission mode', () => {
  it('exposes only ask and bypass and cycles between them', () => {
    expect(nextMode('ask')).toBe('bypass');
    expect(nextMode('bypass')).toBe('ask');
    expect(parsePermissionMode('ask')).toBe('ask');
    expect(parsePermissionMode('bypass')).toBe('bypass');
    expect(parsePermissionMode('acceptEdits')).toBeUndefined();
    expect(parsePermissionMode('yolo')).toBeUndefined();
    expect(parsePermissionMode(undefined)).toBeUndefined();
  });

  it.each(['allow', 'ask', 'deny'] as const)('forwards a legacy %s ruling in ask and approves it in bypass', (outcome) => {
    for (const rule of ['fs.read', 'fs.write.outside', 'exec.disabled', 'tool.switchMode', 'exec.empty', 'exec.nullByte']) {
      const ruling = { outcome, rule, reason: 'legacy setting' };
      expect(applyMode('ask', ruling)).toEqual({ ...ruling, outcome: 'ask' });
      expect(applyMode('bypass', ruling)).toEqual({ ...ruling, outcome: 'allow' });
      expect(modeAllows('ask', rule)).toBe(false);
      expect(modeAllows('bypass', rule)).toBe(true);
    }
  });
});
