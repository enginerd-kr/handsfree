import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeAgent } from './fake-agent.js';
import { harness, scriptedModel, type Harness } from './harness.js';

let open: Harness | undefined;

afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

const delegate = (agent: string, task: string, kind: 'answer' | 'change' = 'change') =>
  JSON.stringify({ action: 'call', tool: 'agent', input: { agent, kind, prompt: task } });
const answer = (message: string) => JSON.stringify({ action: 'answer', message });

/** A long, realistic closing account: what a coding agent says after a change. */
const ACCOUNT = [
  'I looked through the parser and the three call sites that use it, then rewrote',
  'the option handling on top of zod so that unknown flags are reported instead of',
  'silently ignored. The legacy --legacy flag is still accepted; it now prints a',
  'deprecation warning rather than failing. I ran the full test suite twice, once',
  'before and once after, and both runs pass. There is one thing I could not check:',
  'e2e/stage.ts still calls the old signature and I did not touch it.',
]
  .join(' ')
  .repeat(3);

const REPORT = `

REPORT
outcome: done
summary: Moved option parsing to zod; unknown flags now error, --legacy warns.
changed: src/options.ts, src/cli.ts
decided: - kept --legacy as a warning rather than removing it
open: - e2e/stage.ts may still use the old signature
verify: pnpm test`;

/**
 * What the planner reads across a run, in characters, on a fixed scenario:
 * two agents, three tasks, four turns, agents that write at length. The
 * figures are the ones the context-management work is judged by, and the
 * bounds are ceilings that have to hold rather than snapshots that have to
 * match.
 *
 * Two figures, because they move for different reasons. The system prompt is
 * sent on every call and is the bulk of each one; what matters about it is
 * that it never changes, since an endpoint that caches by prefix then pays for
 * it once. Everything after it is what a call actually costs anew, and that is
 * the number the report contract and the folded turns bring down: before
 * them, the same scenario put 29,191 characters through the planner, with a
 * system prompt that changed every turn and results that carried the agents'
 * whole replies.
 */
describe('planner context budget', () => {
  it('keeps the system prompt fixed and everything after it small', async () => {
    let edited = '';
    const claude = fakeAgent({
      script: () => [
        { do: 'tool', toolCallId: 'e1', title: 'Write options.ts', kind: 'edit', locations: [edited] },
        { do: 'say', text: `${ACCOUNT}${REPORT}` },
      ],
    });
    const gemini = fakeAgent({ script: () => [{ do: 'say', text: `${ACCOUNT}${REPORT}` }] });
    const llm = scriptedModel([
      // Turn 1: two tasks, then an answer.
      delegate('claude', 'Move option parsing to zod'),
      delegate('gemini', 'Write tests for the parser'),
      answer('Both done.'),
      // Turn 2: a question to an agent.
      delegate('claude', 'Is the legacy flag still needed?', 'answer'),
      answer('claude thinks it can go.'),
      // Turns 3 and 4: conversation on top of the run so far.
      answer('Nothing else to do.'),
      answer('Bye.'),
    ]);
    const h = harness({
      agents: { claude, gemini },
      llm,
      config: { roles: { claude: 'general coding agent', gemini: 'fast, single-file work' } },
    });
    open = h;
    edited = path.join(h.workspaceDir, 'src/options.ts');

    await h.runtime.conversation.send('move the option parsing to zod and test it');
    await h.runtime.conversation.send('is the legacy flag still needed?');
    await h.runtime.conversation.send('anything else?');
    await h.runtime.conversation.send('thanks');

    expect(llm.seen).toHaveLength(7);
    const system = llm.seen[0]?.[0]?.content ?? '';
    expect(system.length).toBeGreaterThan(0);
    for (const call of llm.seen) expect(call[0]?.content).toBe(system);

    const beyond = llm.seen.reduce(
      (total, messages) =>
        total + messages.slice(1).reduce((sum, message) => sum + message.content.length, 0),
      0,
    );
    const total = beyond + system.length * llm.seen.length;
    // Written down so the figures are in the test output, not only the bounds.
    console.info(
      `planner input across the run: ${total} chars over ${llm.seen.length} calls; ` +
        `${system.length} of each is the fixed system prompt, ${beyond} chars in all came after it`,
    );
    expect(beyond).toBeLessThan(6_000);
    // The agents said this much; none of it reached the planner verbatim.
    expect(JSON.stringify(llm.seen)).not.toContain('I looked through the parser');
  });
});
