import { describe, expect, it } from 'vitest';
import { buildBrief } from './prompts.js';

const base = { doneWhen: undefined, workspaceDir: '/ws', first: false };

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
    expect(first).toContain('Work inside /ws');
    expect(later).not.toContain('Work inside');
  });
});
