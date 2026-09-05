import { describe, expect, it } from 'vitest';
import { renderOutcome, summarise } from './outcome.js';

describe('compact outcomes', () => {
  it('preserves blocked status and blockers before a large artifact list', () => {
    const outcome = summarise(1, 'a', 'Fix', 'end_turn', [], 0);
    outcome.status = 'blocked';
    outcome.report.open = ['Missing API credentials'];
    outcome.report.summary = 'Cannot finish integration';
    outcome.changed = Array.from({ length: 100 }, (_, i) => `/project/src/file-${i}.ts`);
    const text = renderOutcome(outcome, '/project', { maxChars: 256 });
    expect(text).toContain('Task 1 (a): blocked');
    expect(text).toContain('Missing API credentials');
    expect(text).toContain('details in task result');
    expect(text.length).toBeLessThanOrEqual(256);
  });

  it('marks truncation when even required detail is too large', () => {
    const outcome = summarise(2, 'a', 'Fix', 'end_turn', [], 0);
    outcome.status = 'blocked';
    outcome.report.open = ['Missing key. '.repeat(100)];
    const text = renderOutcome(outcome, '/project', { maxChars: 256 });
    expect(text).toContain('blocked');
    expect(text).toContain('details omitted; retrieve task result');
    expect(text.length).toBeLessThanOrEqual(256);
  });
});
