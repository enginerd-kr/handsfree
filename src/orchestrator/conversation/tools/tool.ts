import { z } from 'zod';
import type { JsonSchemaSpec } from '../../../models/client.js';
import { extractJsonObject } from '../../../models/json.js';
import type { TaskOutcome } from '../../results/outcome.js';
import { ReviewSchema, type LoopReview } from '../../../contracts/review.js';
import type { ToolReceipt } from '../../../contracts/tool-result.js';

/**
 * A tool is one thing the planner can do besides answer. It is described to
 * the planner in the system prompt, called with an input the planner writes
 * and the tool's own schema checks, and it reports back in text the planner
 * reads on its next step — the way a model calls a function, except that the
 * call is a JSON object in the reply, so the same protocol reaches a local
 * endpoint and a frontier agent over ACP alike.
 */
export interface ToolContext {
  signal: AbortSignal;
  turnId?: number;
  workMode?: 'plan' | 'execute';
  /** A user update wakes waiting tools without cancelling the worker. */
  wakeSignal?: AbortSignal;
}

export interface ToolResult {
  receipt?: ToolReceipt;
  /** What the planner is handed back. Replies remain complete unless it requests a page. */
  text: string;
  /** True when the turn should stop here: what the tool did cannot be built on. */
  halt?: boolean;
  /**
   * What the tool did, as a task on the record, for the account the turn
   * closes on. The agent tool fills this; a tool that runs no agent has no
   * task to report and leaves it out.
   */
  outcome?: TaskOutcome;
  /** A grouped call reports every recipient, with no duplicate singular outcome. */
  outcomes?: TaskOutcome[];
  callsUsed?: number;
  /** A line for the closing account, from a tool that has no outcome to give it. */
  note?: string;
}

/** Preserve prose verbatim, with machine-readable execution facts ahead of it. */
export function renderToolResult(result: ToolResult): string {
  const receipt = result.receipt ?? { status: 'ok', executed: true, created_tasks: [] };
  return `${JSON.stringify(receipt)}\n${result.text}`;
}

export function toolError(code: string, message: string, executed: boolean | null = false, validRefs?: string[]): ToolResult {
  return { text: message, receipt: { status: 'error', executed, created_tasks: [],
    error: { code, message, ...(validRefs ? { valid_refs: validRefs } : {}) } } };
}

export interface Tool<I = unknown> {
  readonly name: string;
  /**
   * The tool as the planner is told about it: what it is for, what its input
   * is, when to call it, and an example or two. Read fresh each time the
   * system prompt is built, so a tool whose description depends on something
   * that moves — a roster — says what is true now.
   */
  describe(): string;
  /**
   * What a call must carry. Read whenever a call is checked or the schema
   * rendered, for the same reason as `describe`.
   */
  readonly input: z.ZodType<I>;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/** A call the planner made, with its input already checked against the tool. */
export interface Invocation {
  name: string;
  /** The call as JSON, as the history should keep it. */
  json: string;
  run(ctx: ToolContext): Promise<ToolResult>;
}

export type Step = (
  { action: 'answer'; message: string } |
  { action: 'call'; call: Invocation } |
  { action: 'continue'; message: string; calls: Invocation[] }
) & { review?: LoopReview };

export type ParsedStep = { ok: true; step: Step } | { ok: false; error: string };

/** The reply's outer shape: an answer, or a call naming a tool. What the call carries is the tool's to check. */
const LegacyEnvelope = z.discriminatedUnion('action', [
  z.object({ review: ReviewSchema.optional(), action: z.literal('answer'), message: z.string().trim().min(1) }),
  z.object({ review: ReviewSchema.optional(), action: z.literal('call'), tool: z.string().min(1), input: z.unknown() }),
]);
const TurnEnvelope = z.object({
  review: ReviewSchema.optional(),
  message: z.string().default(''),
  calls: z.array(z.object({ tool: z.string().min(1), input: z.unknown() })),
  finish: z.boolean(),
});
const Envelope = z.union([LegacyEnvelope, TurnEnvelope]);

export class Toolbox {
  private readonly tools = new Map<string, Tool<unknown>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(tools: readonly Tool<any>[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Two tools are named "${tool.name}".`);
      this.tools.set(tool.name, tool as Tool<unknown>);
    }
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  get(name: string): Tool<unknown> | undefined {
    return this.tools.get(name);
  }

  /** Every tool's description, in the order they were given, for the foot of the system prompt. */
  describe(): string {
    return [...this.tools.values()].map((tool) => tool.describe()).join('\n\n');
  }

  /**
   * The reply's shape for an endpoint that can constrain a reply to a schema:
   * the answer, or one of the tools' calls with that tool's own input inlined.
   */
  jsonSchema(): JsonSchemaSpec {
    const calls = [...this.tools.values()].map((tool) =>
      z.object({ review: ReviewSchema.optional(), action: z.literal('call'), tool: z.literal(tool.name), input: tool.input }),
    );
    const inputs = [...this.tools.values()].map((tool) => z.object({ tool: z.literal(tool.name), input: tool.input }));
    const item = inputs.length ? z.union(inputs) : z.never();
    const turn = z.object({ review: ReviewSchema.optional(), message: z.string(), calls: z.array(item), finish: z.boolean() });
    const shape = z.union([turn, z.object({ review: ReviewSchema.optional(), action: z.literal('answer'), message: z.string().trim().min(1) }), ...calls]);
    return { name: 'handsfree_step', schema: z.toJSONSchema(shape) as Record<string, unknown> };
  }

  /**
   * One step from the planner's reply. The error, where there is one, names
   * what was wrong the way the planner can act on — the tool that does not
   * exist and the ones that do, or the field of the input the tool refused.
   */
  parse(text: string): ParsedStep {
    const json = extractJsonObject(text);
    if (!json) return { ok: false, error: 'No JSON object in the reply.' };

    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
    }

    const envelope = Envelope.safeParse(raw);
    if (!envelope.success) {
      return { ok: false, error: `Does not match the schema: ${envelope.error.issues[0]?.message}` };
    }
    if (!('action' in envelope.data)) {
      const { message, calls, finish, review } = envelope.data;
      if (finish && (calls.length || !message.trim())) return { ok: false, error: 'finish requires a nonempty message and no calls.' };
      if (!finish && !calls.length && !message.trim()) return { ok: false, error: 'A continuation must contain a message or calls.' };
      const checked: Invocation[] = [];
      for (const call of calls) {
        const parsed = this.parse(JSON.stringify({ action: 'call', ...call }));
        if (!parsed.ok) return parsed;
        if (parsed.step.action === 'call') checked.push(parsed.step.call);
      }
      const state = review ? { review } : {};
      return { ok: true, step: finish
        ? { action: 'answer', message, ...state }
        : { action: 'continue', message, calls: checked, ...state } };
    }
    if (envelope.data.action === 'answer') {
      return { ok: true, step: { action: 'answer', message: envelope.data.message,
        ...(envelope.data.review ? { review: envelope.data.review } : {}) } };
    }

    const { tool: name } = envelope.data;
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `"${name}" is not a tool. Tools: ${this.names().join(', ')}.` };
    }
    const input = tool.input.safeParse(envelope.data.input);
    if (!input.success) {
      const issue = input.error.issues[0];
      const where = issue?.path.length ? `"${issue.path.map(String).join('.')}" ` : '';
      return { ok: false, error: `Input for "${name}" does not match: ${where}${issue?.message ?? 'invalid'}.` };
    }
    const checked = input.data;
    return {
      ok: true,
      step: {
        action: 'call',
        ...(envelope.data.review ? { review: envelope.data.review } : {}),
        call: {
          name,
          json: JSON.stringify({ action: 'call', tool: name, input: checked }),
          run: (ctx) => tool.run(checked, ctx),
        },
      },
    };
  }
}
