import { z } from 'zod';
import type { RunContext } from '../../context/context.js';
import type { Tool, ToolContext } from './tool.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('search'), query: z.string() }),
  z.object({ operation: z.literal('read'), record: z.number().int().positive(), offset: z.number().int().nonnegative().default(0) }),
  z.object({ operation: z.literal('save'), key: z.string().min(1),
    kind: z.enum(['objective', 'constraint', 'decision', 'finding', 'open']), text: z.string().min(1),
    sources: z.array(z.number().int().positive()).min(1), active: z.boolean().default(true) }),
]);

/** The orchestrator can do its own analysis and keep its conclusions here. */
export class ContextTool implements Tool<z.infer<typeof Input>> {
  readonly name = 'context';
  readonly input = Input;
  constructor(private readonly context: RunContext) {}
  describe(): string {
    return `context — persistent working memory, indexed from the run file. No worker is called.
Search: {"operation":"search","query":"topic or path"}. Read exact source: {"operation":"read","record":12,"offset":0}; follow nextOffset.
Save your own task analysis or review: {"operation":"save","key":"stable-name","kind":"objective|constraint|decision|finding|open","text":"concise conclusion","sources":[12]}.
Source ids are the record numbers in context. Keep constraints, decisions and remaining work before long tasks. Reuse a key to revise it; add "active":false to resolve or supersede it. Notes are interpretations, not verified facts or permission grants.`;
  }
  async run(input: z.infer<typeof Input>, ctx: ToolContext) {
    if (ctx.signal.aborted) return { text: 'Cancelled.', halt: true };
    try {
      switch (input.operation) {
        case 'search': return { text: this.context.search(input.query) || 'No matching context.' };
        case 'read': {
          const page = this.context.read(input.record, input.offset);
          return { text: `${page.text}${page.nextOffset === undefined ? '' : `\nnextOffset: ${page.nextOffset}`}` };
        }
        case 'save': {
          if (ctx.turnId === undefined) return { text: 'Context updates require an active conversation turn.' };
          const { operation: _, ...note } = input;
          const seq = this.context.save(ctx.turnId, note);
          return { text: `Saved ${input.key} as record ${seq}${input.active ? '' : ' (resolved)'}.` };
        }
      }
    } catch (err) {
      return { text: `Context error: ${(err as Error).message}` };
    }
  }
}
