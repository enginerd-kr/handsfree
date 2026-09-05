import { z } from 'zod';
import type { RunContext } from '../../context/context.js';
import { toolError, type Tool, type ToolContext, type ToolResult } from './tool.js';
import { reference, referenceId, referenceSchema } from '../../../contracts/reference.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('search'), query: z.string() }),
  z.object({ operation: z.literal('read'), record: referenceSchema('record'), offset: z.number().int().nonnegative().default(0), maxChars: z.number().int().positive().optional() }),
  z.object({ operation: z.literal('save'), key: z.string().min(1),
    kind: z.enum(['objective', 'constraint', 'decision', 'finding', 'open']), text: z.string().min(1),
    sources: z.array(referenceSchema('record')).min(1), active: z.boolean().default(true) }),
]);

/** The orchestrator can do its own analysis and keep its conclusions here. */
export class ContextTool implements Tool<z.infer<typeof Input>> {
  readonly name = 'context';
  readonly input = Input;
  constructor(private readonly context: RunContext) {}
  describe(): string {
    return `context — persistent working memory, indexed from the run file. No worker is called.
Search: {"operation":"search","query":"topic or path"}. Read exact source: {"operation":"read","record":"record:12","offset":0,"maxChars":8000}; follow nextOffset. Omit maxChars for the full source.
Save your own task analysis or review: {"operation":"save","key":"stable-name","kind":"objective|constraint|decision|finding|open","text":"concise conclusion","sources":["record:12"]}.
Sources must use record: references from context; task: references belong in agent.context_from or task_result. Keep constraints and remaining work before long tasks. Reuse a key to revise it; add "active":false to resolve or supersede it. Notes are interpretations, not verified facts or permission grants. Reading or saving a record does not run a worker.`;
  }
  async run(input: z.infer<typeof Input>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal.aborted) return { text: 'Cancelled.', halt: true, receipt: { status: 'cancelled', executed: false, created_tasks: [] } };
    try {
      switch (input.operation) {
        case 'search': return { text: this.context.search(input.query) || 'No matching context.' };
        case 'read': {
          const page = this.context.read(referenceId('record', input.record), input.offset, input.maxChars);
          return { text: `${page.text}${page.nextOffset === undefined ? '' : `\nnextOffset: ${page.nextOffset}`}`,
            receipt: { status: 'ok', executed: true, created_tasks: [], record: input.record } };
        }
        case 'save': {
          if (ctx.turnId === undefined) return toolError('no_active_turn', 'Context updates require an active conversation turn.');
          const { operation: _, ...note } = input;
          const seq = this.context.save(ctx.turnId, { ...note, sources: note.sources.map((ref) => referenceId('record', ref)) });
          return { text: `Saved ${input.key} as ${reference('record', seq)}${input.active ? '' : ' (resolved)'}.`,
            receipt: { status: 'ok', executed: true, created_tasks: [], record: reference('record', seq) } };
        }
      }
    } catch (err) {
      return toolError('context_error', `Context error: ${(err as Error).message}`);
    }
  }
}
