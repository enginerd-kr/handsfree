import { z } from 'zod';
import type { WorkMode } from '../../context/work-mode.js';
import { toolError, type Tool, type ToolContext, type ToolResult } from './tool.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read') }),
  z.object({ operation: z.literal('save'), text: z.string().trim().min(1) }),
]);

export class PlanTool implements Tool<z.infer<typeof Input>> {
  readonly name = 'plan';
  readonly input = Input;
  constructor(private readonly mode: WorkMode) {}
  describe(): string {
    return 'plan — read or save the persistent implementation plan. Input: {"operation":"read"} or {"operation":"save","text":"Markdown plan including decisions and verification"}. Saving a plan does not switch work mode or request permission. The user chooses /plan or /execute; continue using this same loop.';
  }
  async run(input: z.infer<typeof Input>, ctx: ToolContext): Promise<ToolResult> {
    if (input.operation === 'read') return { text: this.mode.prompt() };
    if (ctx.signal.aborted) return { text: 'Cancelled.', halt: true, receipt: { status: 'cancelled', executed: false, created_tasks: [] } };
    if (ctx.turnId === undefined) return toolError('no_active_turn', 'Saving a plan requires a conversation turn.');
    this.mode.save(ctx.turnId, input.text);
    return { text: `Plan saved to ${this.mode.file}.\n${input.text}` };
  }
}
