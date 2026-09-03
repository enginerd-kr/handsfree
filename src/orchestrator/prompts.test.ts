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

  it('spells out the report format with the rules, and only reminds after that', () => {
    const first = buildBrief({ ...base, kind: 'change', task: 'x', first: true });
    const later = buildBrief({ ...base, kind: 'change', task: 'x' });
    expect(first).toContain('outcome: done | partial | blocked');
    expect(first).toContain('verify:');
    expect(later).not.toContain('outcome: done | partial | blocked');
    expect(later.endsWith('End your turn with a REPORT block.')).toBe(true);
  });

  it('puts the planner\'s context after the task and before the handoff', () => {
    const brief = buildBrief({
      ...base,
      kind: 'change',
      task: 'Rename the flag',
      context: 'The user wants --strict.',
      handoff: 'Since your last task:\n- gemini, task 1: changed a.ts',
    });
    const at = (needle: string) => brief.indexOf(needle);
    expect(at('Rename the flag')).toBeLessThan(at('Context: The user wants --strict.'));
    expect(at('Context:')).toBeLessThan(at('Since your last task:'));
  });
});
