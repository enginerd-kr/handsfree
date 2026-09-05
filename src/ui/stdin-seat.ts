import readline from 'node:readline/promises';
import type { Escalator, InputAnswer, InputField, InputValue } from '../policy/types.js';

/**
 * The human seat without a UI. `handsfree run` has no frame to draw a question
 * in, but it usually does have the person who typed the command still sitting
 * there — and an agent that stops to ask something deserves better than a
 * refusal that happens to be the default.
 *
 * Questions are asked on stderr so a piped or `--json` run stays machine
 * readable, and the seat only exists where stdin is a terminal: in CI, where
 * nobody is watching, escalation goes back to being a denial.
 */
export function stdinSeat(): Escalator | undefined {
  if (!process.stdin.isTTY) return undefined;

  return {
    async ask(question) {
      const answer = await line(
        `\n${question.context.agentId} wants to ${question.summary}` +
          `${question.detail ? `\n  ${question.detail}` : ''}` +
          `\n  ${question.approvalLabel ?? 'allow once'}? [y/N] `,
        question.signal,
      );
      const said = (answer ?? '').trim().toLowerCase();
      return said === 'y' || said === 'yes';
    },

    async input(question): Promise<InputAnswer> {
      const content: Record<string, InputValue> = {};
      let opened = false;
      for (const field of question.fields) {
        if (!opened) {
          process.stderr.write(`\n${question.context.agentId} asks: ${question.summary}\n`);
          opened = true;
        }
        const value = await field_(field, question.signal);
        // An unanswerable question is cancelled whole: half a form is not an
        // answer, and the agent is better told nobody replied.
        if (value === 'aborted') return { action: 'cancel' };
        if (value !== undefined) content[field.key] = value;
      }
      return { action: 'accept', content };
    },
  };
}

/** One field, asked until it is answered — or until the question is withdrawn. */
async function field_(
  field: InputField,
  signal: AbortSignal,
): Promise<InputValue | undefined | 'aborted'> {
  const options = field.options ?? [];
  const head =
    `  ${field.label}${field.required ? '' : ' (optional)'}` +
    (field.description ? `\n    ${field.description}` : '') +
    options.map((option, index) => `\n    ${index + 1}) ${option.label}`).join('');

  for (;;) {
    const answer = await line(`${head}\n  ${hint(field)} `, signal);
    if (answer === undefined) return 'aborted';
    const said = answer.trim();

    if (said === '') {
      if (field.default !== undefined) return field.default;
      if (!field.required) return undefined;
      continue;
    }

    switch (field.kind) {
      case 'boolean': {
        const yes = said.toLowerCase();
        if (yes === 'y' || yes === 'yes') return true;
        if (yes === 'n' || yes === 'no') return false;
        continue;
      }
      case 'enum': {
        const picked = options[Number(said) - 1];
        if (picked) return picked.value;
        if (options.some((option) => option.value === said)) return said;
        continue;
      }
      case 'multiselect': {
        const picked = said
          .split(/[,\s]+/)
          .map((token) => options[Number(token) - 1]?.value)
          .filter((value): value is string => value !== undefined);
        if (picked.length > 0) return picked;
        continue;
      }
      case 'number':
      case 'integer': {
        const number = Number(said);
        if (!Number.isFinite(number)) continue;
        if (field.kind === 'integer' && !Number.isInteger(number)) continue;
        return number;
      }
      default:
        return said;
    }
  }
}

function hint(field: InputField): string {
  switch (field.kind) {
    case 'boolean':
      return '[y/n]';
    case 'enum':
      return '[number]';
    case 'multiselect':
      return '[numbers, comma separated]';
    case 'number':
    case 'integer':
      return '[number]';
    default:
      return '>';
  }
}

/**
 * One line from the terminal, or nothing at all if the question is withdrawn
 * first. The interface is opened per question and closed after: a run holding
 * stdin open between turns is a run that will not exit when it is done.
 */
async function line(query: string, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(query, { signal });
  } catch {
    return undefined;
  } finally {
    rl.close();
    // A readline that has read from a TTY leaves stdin flowing, and a flowing
    // stdin holds the event loop open long after the run is done.
    process.stdin.pause();
  }
}
