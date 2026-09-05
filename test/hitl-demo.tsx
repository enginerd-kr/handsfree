import React from 'react';
import { render } from 'ink';
import { App } from '../src/ui/tui/app.js';
import type { ChatClient } from '../src/models/client.js';
import { fakeAgent, type Act } from './fake-agent.js';
import { harness } from './harness.js';

/**
 * The three ways an agent can stop, driven by hand rather than by a test.
 *
 *   pnpm tsx test/hitl-demo.tsx           a permission question
 *   pnpm tsx test/hitl-demo.tsx always    an agent offering no single-use yes
 *   pnpm tsx test/hitl-demo.tsx form      a question of the agent's own
 *   pnpm tsx test/hitl-demo.tsx slow      a permission question, then a long silence
 *
 * Type anything at the prompt and press enter; the line goes straight to the
 * scripted agent, which stops in the chosen way. Answer it and the turn
 * carries on. `slow` is the one to watch a clock against: the agent goes quiet
 * for a minute after you answer, well past the 10s idle timeout this demo
 * sets, and the turn must still finish rather than being cancelled underneath
 * the question.
 */
const WHICH = process.argv[2] ?? 'permission';

const SCRIPTS: Record<string, Act[]> = {
  permission: [
    { do: 'ask', title: 'Do something unusual', kind: 'other' },
    { do: 'say', text: 'and then I carried on.' },
  ],
  always: [
    {
      do: 'ask',
      title: 'Rewrite every file in the workspace',
      kind: 'other',
      options: [
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
      onAnswer: (id) => log(`the agent was answered: ${id}`),
    },
    { do: 'say', text: 'and then I carried on.' },
  ],
  form: [
    {
      do: 'elicit',
      message: 'Rewrite the module or patch it? And what should I call the new file?',
      schema: {
        type: 'object',
        properties: {
          approach: {
            type: 'string',
            title: 'Which approach?',
            description: 'A rewrite touches everything; a patch is smaller.',
            enum: ['rewrite', 'patch'],
          },
          name: { type: 'string', title: 'Name the file' },
          tests: { type: 'boolean', title: 'Write tests too?' },
        },
        required: ['approach'],
      },
      onAnswer: (response) => log(`the agent was told: ${JSON.stringify(response)}`),
    },
    { do: 'say', text: 'thanks — that is all I needed.' },
  ],
  slow: [
    { do: 'ask', title: 'Do something unusual', kind: 'other' },
    { do: 'stall', ms: 60_000 },
    { do: 'say', text: 'still here, a minute later.' },
  ],
};

const messages: string[] = [];
function log(line: string): void {
  messages.push(line);
}

/** Enough of a model to route the line you typed and sum up afterwards. */
const model: ChatClient = {
  async chat(_messages, options) {
    if (options?.schema) return JSON.stringify({ action: 'answer', message: 'done.' });
    return ['done.', ...messages.splice(0)].join(' ');
  },
};

const script = SCRIPTS[WHICH];
if (!script) {
  console.error(`no such demo as "${WHICH}" — try: ${Object.keys(SCRIPTS).join(', ')}`);
  process.exit(1);
}

const h = harness({
  agents: { claude: fakeAgent({ script: () => script }) },
  llm: model,
  // Deliberately short, so `slow` proves the clocks stand still for a question
  // instead of merely being generous.
  config: {},
});

console.log(`\n  demo: ${WHICH} — type anything and press enter. ctrl+c to leave.\n`);
const app = render(<App runtime={h.runtime} />);
await app.waitUntilExit();
await h.dispose();
