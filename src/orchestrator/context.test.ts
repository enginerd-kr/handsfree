import { describe, expect, it } from 'vitest';
import { Transcript } from '../workspace/transcript.js';
import { RunContext } from './context.js';
import { fitBudget, trimHistory } from '../brain/client.js';

describe('durable run context', () => {
  it('retains distinct retrieved pages together without duplicating repeated reads', () => {
    const transcript = new Transcript();
    const context = new RunContext(transcript);
    const turn = context.start('Compare two results.');
    context.retainEvidence(turn, 'task 1 page 0', 'first finding');
    context.retainEvidence(turn, 'task 2 page 0', 'second finding');
    context.retainEvidence(turn, 'task 1 page 0', 'first finding');
    expect(context.evidenceView(turn, 1000)).toContain('first finding');
    expect(context.evidenceView(turn, 1000)).toContain('second finding');
    expect(transcript.all().filter((r) => r.type === 'context' && r.entry.event === 'evidence')).toHaveLength(2);
    expect(new RunContext(transcript).evidenceView(turn, 1000)).toContain('first finding');
  });

  it('keeps source-linked constraints when chat history is evicted and revisions supersede old notes', () => {
    const transcript = new Transcript();
    const context = new RunContext(transcript);
    const turn = context.start('Preserve --legacy while updating the parser.');
    const note = { key: 'compatibility', kind: 'constraint' as const, text: 'Preserve --legacy.', sources: [turn], active: true };
    const source = context.save(turn, note);
    context.finish(turn, 'reported', 'I will preserve the flag.');
    for (let i = 0; i < 20; i++) {
      const id = context.start(`unrelated ${i}`);
      context.finish(id, 'reported', 'okay');
    }
    const replayed = new RunContext(transcript);
    expect(JSON.stringify(replayed.history(2))).not.toContain('--legacy');
    expect(replayed.required()).toContain('Preserve --legacy.');
    expect(replayed.read(source, 0, 2000).text).toContain(`"sources":[${turn}]`);
    const correction = replayed.start('The flag can now be removed.');
    replayed.save(correction, { ...note, text: 'Remove --legacy.', sources: [correction] });
    expect(replayed.required()).not.toContain('Preserve --legacy.');
    expect(replayed.required()).toContain('Remove --legacy.');
    expect(replayed.search('compatibility')).not.toContain(`[record ${source};`);
    replayed.save(correction, { ...note, text: 'Compatibility change finished.', sources: [correction], active: false });
    expect(replayed.required()).toBe('');
    // Superseded sources remain readable, even though retrieval prefers the revision.
    expect(replayed.read(source, 0, 2000).text).toContain('Preserve --legacy.');
  });

  it('pages exact source text and recovers interrupted requests without inventing completion', () => {
    const transcript = new Transcript();
    const context = new RunContext(transcript);
    const turn = context.start('Do the first task, then verify.');
    context.step(turn, '{"action":"call","tool":"agent","input":{"agent":"claude","prompt":"first task"}}');
    const replayed = new RunContext(transcript);
    const chunks: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = replayed.read(turn, offset, 25);
      chunks.push(page.text);
      offset = page.nextOffset;
    }
    expect(JSON.parse(chunks.join('')).entry.request).toBe('Do the first task, then verify.');
    expect(replayed.history(10)[1]?.content).toContain('interrupted before reporting');
    expect(replayed.search('first task')).toContain('"tool":"agent"');
  });

  it('clears notes, search and source access and rejects orphaned updates', () => {
    const transcript = new Transcript();
    const context = new RunContext(transcript);
    const turn = context.start('private old request');
    transcript.append({ type: 'clear' });
    context.finish(turn, 'reported', 'late answer');
    expect(context.history(10)).toEqual([]);
    expect(context.search('private')).toBe('');
    expect(() => context.read(turn, 0, 100)).toThrow('No context record');
    expect(() => context.save(turn, { key: 'old', kind: 'finding', text: 'late', sources: [turn], active: true })).toThrow('cleared');
    const fresh = context.start('new request');
    expect(() => context.save(fresh, { key: 'invalid', kind: 'constraint', text: 'made up', sources: [turn], active: true })).toThrow('not in this conversation');
  });

  it('evicts whole conversation pairs while keeping system and required constraints', () => {
    const system = { role: 'system' as const, content: 'rules' };
    const exchanges = [1, 2, 3].flatMap((i) => [{ role: 'user' as const, content: `question ${i}` }, { role: 'assistant' as const, content: `answer ${i}` }]);
    expect(trimHistory([system, ...exchanges], 3).map((m) => m.content)).toEqual(['rules', 'question 3', 'answer 3']);
    expect(trimHistory(exchanges, 3).map((m) => m.content)).toEqual(['question 3', 'answer 3']);
    const required = { role: 'user' as const, pinned: true, content: 'optional '.repeat(100) + 'Keep --legacy', requiredContent: 'Keep --legacy' };
    expect(fitBudget([system, ...exchanges, required], 20).at(-1)?.content).toBe('Keep --legacy');
    expect(() => fitBudget([system, required], 1)).toThrow('Required task context');
  });
});
