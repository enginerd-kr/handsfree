import { describe, expect, it } from 'vitest';
import { buildBrief } from './prompts.js';

const base = { workspaceDir: '/ws', first: false };

describe('buildBrief', () => {
  it('tells an agent asked a question to answer rather than build', () => {
    const brief = buildBrief({ ...base, kind: 'answer', task: '안녕?' });
    expect(brief).toContain('안녕?');
    expect(brief).toContain('Put your answer in your reply');
    expect(brief).toContain('Do not create, modify or delete any file');
  });

  it('leaves a change task free to touch the workspace', () => {
    const brief = buildBrief({ ...base, kind: 'change', task: 'Create notes.txt' });
    expect(brief).not.toContain('Do not create');
  });

  it('carries the ground rules only on the first brief of a session', () => {
    const first = buildBrief({ ...base, kind: 'change', task: 'x', first: true });
    const later = buildBrief({ ...base, kind: 'change', task: 'x' });
    expect(first).toContain('The working directory is /ws');
    expect(later).not.toContain('The working directory');
  });

  it('specifies verification reports for work even after earlier tasks in the session', () => {
    const first = buildBrief({ ...base, kind: 'change', task: 'x', first: true });
    const later = buildBrief({ ...base, kind: 'change', task: 'x' });
    expect(first).toContain('outcome: done | partial | blocked');
    expect(first).toContain('verify:');
    expect(later).toContain('outcome: done | partial | blocked');
    expect(later).toContain('verify:');
  });

  it.each([true, false])('requests a plain answer without a work report (first=%s)', (first) => {
    const brief = buildBrief({ ...base, first, kind: 'answer', task: 'Answer in two sentences.' });
    expect(brief).toContain('Follow the requested response length and format');
    expect(brief).toContain('do not append a REPORT block');
    expect(brief).not.toContain('outcome: done | partial | blocked');
    expect(brief).not.toContain('verify:');
  });

  it('keeps file freshness notices separate from the requested task', () => {
    const brief = buildBrief({
      ...base,
      kind: 'change',
      task: 'Rename the flag. Done when --strict is the only spelling.',
      staleFiles: ['a.ts'],
    });
    const at = (needle: string) => brief.indexOf(needle);
    expect(at('Rename the flag')).toBeLessThan(at('Previously seen files changed on disk'));
    expect(brief).toContain('re-read if relevant: a.ts');
  });
});
