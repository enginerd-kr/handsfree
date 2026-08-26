import { describe, expect, it } from 'vitest';
import type { RunResult } from '../agents/runner.js';
import type { ParsedOutput } from '../agents/types.js';
import { classifyOutcome } from './outcome.js';

const run = (over: Partial<RunResult> = {}): RunResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  output: '',
  timedOut: false,
  aborted: false,
  ...over,
});

const parsed = (over: Partial<ParsedOutput> = {}): ParsedOutput => ({
  finalMessage: '',
  isError: false,
  denials: [],
  denialHints: [],
  ...over,
});

describe('classifyOutcome', () => {
  it('reports a clean run as success', () => {
    expect(classifyOutcome(run(), parsed())).toBe('success');
  });

  it('prefers cancellation over every other signal', () => {
    expect(
      classifyOutcome(run({ aborted: true, exitCode: 1, timedOut: true }), parsed({ isError: true })),
    ).toBe('cancelled');
  });

  it('reports a timeout as a timeout, not an error', () => {
    expect(classifyOutcome(run({ timedOut: true, exitCode: 1 }), parsed())).toBe('timeout');
  });

  it('treats a structural denial as blocking even on a zero exit code', () => {
    expect(classifyOutcome(run(), parsed({ denials: ['{"tool_name":"Bash"}'] }))).toBe(
      'blocked_by_permissions',
    );
  });

  it('reports a nonzero exit as an error', () => {
    expect(classifyOutcome(run({ exitCode: 1 }), parsed())).toBe('error');
  });

  it('reports a structured error flag as an error', () => {
    expect(classifyOutcome(run(), parsed({ isError: true }))).toBe('error');
  });
});
