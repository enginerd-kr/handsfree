import { describe, expect, it } from 'vitest';
import { parseReport, REPORT_FORMAT } from './report.js';

const PLAIN = `I rewrote the parser and ran the tests.

REPORT
outcome: done
summary: Moved option parsing to zod; unknown flags now error.
changed: src/options.ts, src/cli.ts
decided: - kept --legacy as a warning, since two scripts still pass it
open: - e2e/stage.ts may still use the old signature
verify: pnpm test`;

describe('parseReport', () => {
  it('reads a block written the way it was asked for', () => {
    const report = parseReport(PLAIN);
    expect(report.structured).toBe(true);
    expect(report.outcome).toBe('done');
    expect(report.summary).toBe('Moved option parsing to zod; unknown flags now error.');
    expect(report.changed).toEqual(['src/options.ts', 'src/cli.ts']);
    expect(report.decided).toEqual(['kept --legacy as a warning, since two scripts still pass it']);
    expect(report.open).toEqual(['e2e/stage.ts may still use the old signature']);
    expect(report.verify).toBe('pnpm test');
  });

  it('takes the block as claude writes it: a bold heading, bold keys, a fence', () => {
    const text = `All done.

\`\`\`
**REPORT**
**outcome:** done
**summary:** Added parse().
**changed:** \`a.ts\`
**decided:**
- empty input returns null
**open:** none
**verify:** \`pnpm test\`
\`\`\``;
    const report = parseReport(text);
    expect(report.structured).toBe(true);
    expect(report.outcome).toBe('done');
    expect(report.summary).toBe('Added parse().');
    expect(report.changed).toEqual(['a.ts']);
    expect(report.decided).toEqual(['empty input returns null']);
    expect(report.open).toEqual([]);
    expect(report.verify).toBe('pnpm test');
  });

  it('takes the block as a markdown header, with items on the field line', () => {
    const text = `## REPORT
outcome: partial
summary: Two of three tests pass.
decided: kept the old signature; added a shim
open: - the third test needs a fixture
- and a network mock`;
    const report = parseReport(text);
    expect(report.outcome).toBe('partial');
    // One item: the semicolon is the agent's punctuation, not a separator.
    expect(report.decided).toEqual(['kept the old signature; added a shim']);
    expect(report.open).toEqual(['the third test needs a fixture', 'and a network mock']);
  });

  it('reads the last block when the agent quoted the format back first', () => {
    const text = `${REPORT_FORMAT}\n\nDone.\n\nREPORT\noutcome: done\nsummary: Real one.`;
    expect(parseReport(text).summary).toBe('Real one.');
  });

  it('joins a summary that wrapped onto the next line', () => {
    const text = 'REPORT\nsummary: The first half of the sentence\ncontinues here.\nverify: none';
    expect(parseReport(text).summary).toBe('The first half of the sentence continues here.');
  });

  it('falls back to the tail of the message when there is no block', () => {
    const long = `${'The account goes on and on. '.repeat(40)}The end.`;
    const report = parseReport(long);
    expect(report.structured).toBe(false);
    expect(report.outcome).toBeUndefined();
    expect(report.summary.endsWith('The end.')).toBe(true);
    expect(report.summary.length).toBeLessThanOrEqual(300);
    expect(report.changed).toEqual([]);
  });

  it('uses the whole message as the summary when it is short and unstructured', () => {
    expect(parseReport('Created notes.txt.').summary).toBe('Created notes.txt.');
    expect(parseReport('').summary).toBe('');
  });

  it('caps the summary and the item lists to the limits it is given', () => {
    const text = `REPORT\nsummary: ${'x'.repeat(500)}\nopen: - a\n- b\n- c\n- d`;
    const report = parseReport(text, { summaryChars: 50, items: 2, itemChars: 20 });
    expect(report.summary.length).toBe(50);
    expect(report.open).toEqual(['a', 'b']);
  });

  it('reads the outcome by its first word, in the agent\'s own spelling', () => {
    expect(parseReport('REPORT\noutcome: Done.').outcome).toBe('done');
    expect(parseReport('REPORT\noutcome: blocked — needs a token').outcome).toBe('blocked');
    expect(parseReport('REPORT\noutcome: incomplete').outcome).toBe('partial');
    expect(parseReport('REPORT\noutcome: whatever').outcome).toBeUndefined();
  });
});
