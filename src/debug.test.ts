import { afterEach, describe, expect, it } from 'vitest';
import {
  debug,
  debugDestination,
  debugEnabled,
  debugTargetFromEnv,
  describeProxyEnv,
  disableDebug,
  enableDebug,
  maskProxyUrl,
} from './debug.js';

afterEach(() => disableDebug());

describe('debug', () => {
  it('is silent until enabled', () => {
    const lines: string[] = [];
    debug('area', 'dropped');
    expect(debugEnabled()).toBe(false);

    enableDebug((line) => lines.push(line));
    debug('area', 'kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[debug \d\d:\d\d:\d\d\.\d\d\d\] area: kept$/);
  });

  it('goes silent again when disabled', () => {
    const lines: string[] = [];
    enableDebug((line) => lines.push(line));
    disableDebug();
    debug('area', 'dropped');
    expect(lines).toHaveLength(0);
  });

  it('remembers where the lines are going', () => {
    expect(debugDestination()).toBeUndefined();
    enableDebug(() => {});
    expect(debugDestination()).toBe('stderr');
    enableDebug(() => {}, '/tmp/hf.log');
    expect(debugDestination()).toBe('/tmp/hf.log');
    disableDebug();
    expect(debugDestination()).toBeUndefined();
  });
});

describe('debugTargetFromEnv', () => {
  it('treats unset, empty, 0 and false as off', () => {
    expect(debugTargetFromEnv(undefined)).toBe('off');
    expect(debugTargetFromEnv('')).toBe('off');
    expect(debugTargetFromEnv('0')).toBe('off');
    expect(debugTargetFromEnv('false')).toBe('off');
    expect(debugTargetFromEnv('FALSE')).toBe('off');
  });

  it('treats truthy values as stderr', () => {
    expect(debugTargetFromEnv('1')).toBe('stderr');
    expect(debugTargetFromEnv('true')).toBe('stderr');
  });

  it('treats path-like values as a log file', () => {
    expect(debugTargetFromEnv('/tmp/hf.log')).toEqual({ file: '/tmp/hf.log' });
    expect(debugTargetFromEnv('debug.log')).toEqual({ file: 'debug.log' });
    expect(debugTargetFromEnv('out\\hf.txt')).toEqual({ file: 'out\\hf.txt' });
  });
});

describe('describeProxyEnv', () => {
  it('says so when nothing is set', () => {
    expect(describeProxyEnv({})).toBe('no proxy variables set');
  });

  it('distinguishes an empty variable from an unset one', () => {
    // `HTTP_PROXY= claude` in a shell sets the variable to "", it does not unset it.
    const line = describeProxyEnv({ HTTP_PROXY: '', HTTPS_PROXY: 'http://proxy.corp:8080' });
    expect(line).toContain('HTTP_PROXY=<empty>');
    expect(line).toContain('HTTPS_PROXY=http://proxy.corp:8080');
    expect(line).toContain('unset:');
    expect(line).toContain('NO_PROXY');
    expect(line).not.toContain('HTTPS_PROXY=<empty>');
  });

  it('masks credentials embedded in proxy URLs', () => {
    const line = describeProxyEnv({ HTTPS_PROXY: 'http://alice:s3cret@proxy.corp:8080' });
    expect(line).toContain('http://alice:***@proxy.corp:8080');
    expect(line).not.toContain('s3cret');
  });
});

describe('maskProxyUrl', () => {
  it('hides the password and keeps the user and host', () => {
    expect(maskProxyUrl('http://alice:s3cret@proxy.corp:8080')).toBe('http://alice:***@proxy.corp:8080');
  });

  it('leaves URLs without credentials alone', () => {
    expect(maskProxyUrl('http://proxy.corp:8080')).toBe('http://proxy.corp:8080');
    expect(maskProxyUrl('proxy.corp:8080')).toBe('proxy.corp:8080');
  });
});
