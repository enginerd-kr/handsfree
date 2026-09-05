import { describe, expect, it } from 'vitest';
import { modeAllows, nextMode, parsePermissionMode } from './mode.js';

describe('permission mode', () => {
  it('exposes only ask and bypass and cycles between them', () => {
    expect(nextMode('ask')).toBe('bypass');
    expect(nextMode('bypass')).toBe('ask');
    expect(parsePermissionMode('ask')).toBe('ask');
    expect(parsePermissionMode('bypass')).toBe('bypass');
    expect(parsePermissionMode('acceptEdits')).toBeUndefined();
    expect(parsePermissionMode('yolo')).toBeUndefined();
    expect(parsePermissionMode(undefined)).toBeUndefined();
    expect(modeAllows('ask', 'exec')).toBe(false);
    expect(modeAllows('bypass', 'exec')).toBe(true);
  });

});
