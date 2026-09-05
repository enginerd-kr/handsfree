import './colour.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeAgent, type Act } from '../test/fake-agent.js';
import { open, type Session } from './screen.js';
import { answer, delegate, scripted, stage, type Stage } from './stage.js';
import { toSvg } from './svg.js';

/**
 * The README's pictures, taken from the program rather than written by hand.
 *
 * Each shot opens the real TUI on a screen of its own, drives it the way a
 * person would — a line typed, a key pressed, a menu opened — and saves the
 * frame ink actually drew. The agents are scripted (`test/fake-agent.ts`)
 * because the rows worth showing are the refused ones, and no real adapter
 * refuses on request; everything between the keystroke and the frame is the
 * shipping code, policy engine included, and the commands that do run, run.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'docs', 'screens');

/** The mascot wanders and blinks on a dice roll; a fixed roll keeps re-shoots honest. */
function seedRandom(seed = 0x5eed): void {
  let state = seed;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
}

const MODELS = {
  claude: ['opus[1m]', 'sonnet', 'haiku'],
  codex: ['gpt-5.6', 'gpt-5.6-terra[max]'],
  gemini: ['gemini-3-pro', 'gemini-3-flash'],
};

const NOTES = {
  claude: { note: 'general coding agent, strong at multi-file edits' },
  codex: { note: 'methodical coding agent, good at tests and refactors' },
  gemini: { note: 'fast, good at bulk text and single-file work' },
};

/** A small project for the agent to actually touch, so every ✓ row is a real one. */
function seed(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/parser.ts'),
    'export function tokenize(source: string) {\n  // one loop, escapes tangled into it\n}\n',
  );
  fs.writeFileSync(path.join(dir, 'test.mjs'), 'console.log("48 passed, 0 failed (1.2s)");\n');
}

function save(name: string, frame: string, columns: number, title: string): void {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.svg`), toSvg(frame, { columns, title }));
  process.stdout.write(`  docs/screens/${name}.svg\n`);
}

/** Opens a shot, drives it, saves the frame, and puts the stage away regardless. */
async function shot(
  name: string,
  columns: number,
  rows: number,
  title: string,
  build: () => Stage,
  drive: (session: Session, staged: Stage) => Promise<void>,
): Promise<void> {
  seedRandom();
  const staged = build();
  const session = open(staged.runtime, columns, rows);
  try {
    await session.until('❯');
    await drive(session, staged);
    save(name, session.frame(), columns, title);
  } finally {
    session.close();
    await staged.dispose();
  }
}

const CTRL_O = String.fromCharCode(15);
const drop = (): void => {};

/** The three agents, each with the roster its CLI would advertise. */
function roster(claude: () => Act[]): Record<string, ReturnType<typeof fakeAgent>> {
  return {
    claude: fakeAgent({ models: MODELS.claude, script: claude }),
    codex: fakeAgent({ models: MODELS.codex, script: () => [] }),
    gemini: fakeAgent({ models: MODELS.gemini, script: () => [] }),
  };
}

/** A whole turn: one line in, one agent out, and every side effect on the record. */
async function turn(): Promise<void> {
  let workspace = '';
  await shot(
    'turn',
    96,
    28,
    'handsfree — one turn, end to end',
    () => {
      const staged = stage({
        agents: roster(() => [
          {
            do: 'think',
            text: 'The tokenizer is one loop in src/parser.ts, with the escape handling tangled into it.',
          },
          { do: 'read', path: path.join(workspace, 'src/parser.ts'), onResult: drop },
          {
            do: 'write',
            path: path.join(workspace, 'src/parser.ts'),
            content:
              'export function tokenize(source: string) {\n  // the loop, with readEscape lifted out of it\n}\n\nfunction readEscape(source: string, at: number) {}\n',
            onResult: drop,
          },
          { do: 'exec', command: 'node', args: ['test.mjs'], onResult: drop },
          { do: 'exec', command: 'git', args: ['push', 'origin', 'main'], onResult: drop },
          {
            do: 'say',
            text: 'Lifted the escape handling out of the loop into `readEscape`. Tests pass: 48 passed, 0 failed.',
          },
        ]),
        profiles: NOTES,
        llm: scripted([
          delegate('claude', 'untangle the escape handling in src/parser.ts and run the tests'),
          answer(
            'Done — the escape handling is its own function now and the suite is green. One thing was refused: `git push origin main` was declined by the user.',
          ),
        ]),
      });
      workspace = staged.runtime.workspace.dir;
      seed(workspace);
      return staged;
    },
    async (session, staged) => {
      // Script the user's answers: approve reading, writing and tests; decline the push.
      const answers = [true, true, true, false];
      staged.runtime.setEscalator({ ask: async () => answers.shift() ?? false });
      await staged.runtime.conversation.send(
        'untangle the escape handling in the tokenizer, then run the tests',
      );
      await session.until('Done —');
      // Folded is how a finished task rests; the picture is worth more open.
      await session.press(CTRL_O);
      await session.until('readEscape');
      await session.settle(150);
    },
  );
}

/** Ask mode shows every permission request to the user. */
async function permission(): Promise<void> {
  let workspace = '';
  await shot(
    'permission',
    96,
    28,
    'handsfree — the decision it will not take for you',
    () => {
      const staged = stage({
        agents: roster(() => [
          { do: 'think', text: 'The tests will tell me whether the lift held.' },
          { do: 'read', path: path.join(workspace, 'src/parser.ts'), onResult: drop },
          {
            do: 'write',
            path: path.join(workspace, 'src/parser.ts'),
            content: 'export function tokenize(source: string) {}\n',
            onResult: drop,
          },
          { do: 'exec', command: 'node', args: ['test.mjs'], onResult: drop },
          { do: 'stall', ms: 30_000 },
        ]),
        profiles: NOTES,
        llm: scripted([
          delegate('claude', 'untangle the escape handling in src/parser.ts and run the tests'),
        ]),
      });
      workspace = staged.runtime.workspace.dir;
      seed(workspace);
      return staged;
    },
    async (session, staged) => {
      // Not awaited: the shot is of the turn while it waits on an answer.
      void staged.runtime.conversation.send(
        'untangle the escape handling in the tokenizer, then run the tests',
      );
      await session.until('allow once');
      await session.settle(150);
    },
  );
}

/**
 * The opening frame, before a word has been typed: the greeting the empty
 * transcript stands in for, and the examples spelled with this run's own
 * agents — which is the whole point of it, so the shot uses the same three
 * the other pictures do rather than a cast of its own.
 */
async function welcome(): Promise<void> {
  await shot(
    'welcome',
    96,
    24,
    'handsfree — before a word is typed',
    () =>
      stage({
        agents: roster(() => []),
        profiles: NOTES,
        // Nothing is sent, so nothing plans; a reply left here could only ever
        // be one nobody asked for.
        llm: scripted([]),
      }),
    async (session) => {
      await session.until('/agents');
      await session.settle(150);
    },
  );
}

process.stdout.write('shooting the README:\n');
await welcome();
await turn();
await permission();
process.stdout.write('done.\n');
process.exit(0);
