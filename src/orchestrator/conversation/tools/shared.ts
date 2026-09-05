import { z } from 'zod';
import { referenceSchema } from '../../../contracts/reference.js';
import type { SharedConversations } from '../../context/shared.js';
import { toolError, type Tool, type ToolContext, type ToolResult } from './tool.js';

const Input = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('open'), title: z.string().trim().min(1) }),
  z.object({ operation: z.literal('list') }),
  z.object({ operation: z.literal('read'), conversation: referenceSchema('conversation'), through: referenceSchema('record').optional() }),
  z.object({ operation: z.literal('continue'), conversation: referenceSchema('conversation') }),
  z.object({ operation: z.literal('note'), conversation: referenceSchema('conversation'), text: z.string().min(1) }),
  z.object({ operation: z.literal('attach'), conversation: referenceSchema('conversation'), context_from: z.array(referenceSchema('task')).min(1) }),
]);

export class SharedContextTool implements Tool<z.infer<typeof Input>> {
  readonly name = 'shared_context';
  readonly input = Input;
  constructor(private readonly shared: SharedConversations) {}
  describe(): string {
    return `shared_context — a scoped public conversation for collaboration, review or handoff. Keeps exact user requests, updates and worker replies with authors and order. It never chooses speakers or declares completion.
Open from the current user request: {"operation":"open","title":"collaboration topic"}. Returns a conversation reference and its through record. Wait for that result before calling a worker with shared_context; never invent IDs or assume a user request record is a shared message. List existing collaborations: {"operation":"list"}.
Opening a scope does not automatically enroll worker calls. Select its snapshot in every participating agent call, including the initial independent contributions, or their replies will not enter this conversation. After open/continue, omission is rejected; shared_context:null explicitly selects an ordinary call outside the collaboration.
Read the entire latest conversation: {"operation":"read","conversation":"conversation:12"}; optionally add "through":"record:24" for an older prefix. The returned messages are complete source text, never a generated summary.
On a later user turn, use {"operation":"continue","conversation":"conversation:12"} to add the actual current request and keep this collaboration. Unrelated requests are not added automatically. User updates during an included turn are recorded automatically; read again to choose a newer snapshot.
Share your own conclusion explicitly: {"operation":"note","conversation":"conversation:12","text":"your analysis"}. It is labeled as the orchestrator's interpretation, not as a user instruction or worker reply.
Connect existing worker replies that were produced outside this scope: {"operation":"attach","conversation":"conversation:12","context_from":["task:1","task:2"]}. This publishes their saved original text with source authors and statuses, without rerunning workers. Repeated attachments do not duplicate replies. The returned head includes them; older snapshots remain unchanged. Reading a result or passing agent.context_from alone does not publish it here.
Pass an exact snapshot to agent.shared_context: {"conversation":"conversation:12","through":"record:24"}. Calls with that selection receive identical accumulated conversation text, including both sides' earlier replies. New replies are published to that conversation and the execution receipt returns conversation_head for your next choice.
For independent positions, use the same initial snapshot. For a response to new evidence, await its result and select a snapshot including it. A group sees one fixed snapshot; it cannot see new replies from earlier recipients in that group. Keep the current task in agent.prompt. context_from remains available for additional individual task results. Session memory is not a substitute for selecting shared context.`;
  }
  async run(input: z.infer<typeof Input>, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal.aborted) return { text: 'Cancelled.', halt: true, receipt: { status: 'cancelled', executed: false, created_tasks: [] } };
    try {
      if (input.operation === 'list') return { text: JSON.stringify(this.shared.list()) };
      let selection;
      switch (input.operation) {
        case 'open':
        case 'continue':
          if (ctx.turnId === undefined) return toolError('no_active_turn', 'Sharing a user request requires an active turn.');
          selection = input.operation === 'open' ? this.shared.open(ctx.turnId, input.title) : this.shared.include(input.conversation, ctx.turnId);
          break;
        case 'read': selection = input.through ? { conversation: input.conversation, through: input.through } : this.shared.head(input.conversation); break;
        case 'note': selection = this.shared.note(input.conversation, input.text); break;
        case 'attach': selection = this.shared.attach(input.conversation, input.context_from); break;
      }
      const snapshot = this.shared.resolve(selection);
      return { text: JSON.stringify(snapshot), receipt: { status: 'ok', executed: true, created_tasks: [],
        observed_tasks: snapshot.messages.flatMap((message) => message.task ? [message.task] : []),
        shared_context: selection, conversation_head: this.shared.head(selection.conversation) } };
    } catch (error) {
      return toolError('invalid_shared_context', `Shared context error: ${(error as Error).message}`, input.operation === 'read' ? false : null,
        this.shared.list().flatMap(({ conversation, through }) => [conversation, through]));
    }
  }
}
