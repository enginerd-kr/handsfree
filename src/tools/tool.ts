import { z } from 'zod';
import type { JsonSchemaSpec } from '../brain/client.js';
import { extractJsonObject } from '../brain/json.js';
import type { TaskOutcome } from '../orchestrator/outcome.js';

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
}

export interface ToolResult {
  /**
   * What the planner is handed back. Kept within the run's result limit by
   * the tool itself, which knows what part of its result matters most.
   */
  text: string;
  /** True when the turn should stop here: what the tool did cannot be built on. */
  halt?: boolean;
  /**
   * What the tool did, as a task on the record, for the account the turn
   * closes on. The agent tool fills this; a tool that runs no agent has no
   * task to report and leaves it out.
   */
  outcome?: TaskOutcome;
  /** A line for the closing account, from a tool that has no outcome to give it. */
  note?: string;
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

export type Step = { action: 'answer'; message: string } | { action: 'call'; call: Invocation };

export type ParsedStep = { ok: true; step: Step } | { ok: false; error: string };

/** The reply's outer shape: an answer, or a call naming a tool. What the call carries is the tool's to check. */
const Envelope = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answer'), message: z.string() }),
  z.object({ action: z.literal('call'), tool: z.string().min(1), input: z.unknown() }),
]);

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
      z.object({ action: z.literal('call'), tool: z.literal(tool.name), input: tool.input }),
    );
    const shape = z.union([z.object({ action: z.literal('answer'), message: z.string() }), ...calls]);
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
    if (envelope.data.action === 'answer') {
      return { ok: true, step: { action: 'answer', message: envelope.data.message } };
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
        call: {
          name,
          json: JSON.stringify({ action: 'call', tool: name, input: checked }),
          run: (ctx) => tool.run(checked, ctx),
        },
      },
    };
  }
}
