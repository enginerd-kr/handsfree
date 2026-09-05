import { z } from 'zod';
import type { Delegator } from '../../execution/delegate.js';
import { renderOutcome, type TaskOutcome } from '../../results/outcome.js';
import type { Transcript } from '../../../workspace/transcript.js';
import type { Workspace } from '../../../workspace/workspace.js';
import { renderToolResult, toolError, type Tool, type ToolContext, type ToolResult } from './tool.js';
import type { AgentJobs } from '../jobs.js';
import { reference, referenceId, referenceSchema } from '../../../contracts/reference.js';
import { SharedContextSchema, type SharedContextSelection, type SharedContextSnapshot } from '../../../contracts/shared-context.js';
import type { SharedConversations } from '../../context/shared.js';

export interface AgentCard {
  id: string;
  /** What the agent is for: its configured role, or the launch profile's note. */
  description: string;
}

export interface AgentToolDeps {
  jobs?: AgentJobs;
  onOutcome?: (outcome: TaskOutcome) => void;
  readOutcome?: (taskId: number) => TaskOutcome;
  taskRefs?: () => string[];
  shared?: SharedConversations;
  /**
   * Who can be called, read each time the tool is described or a call is
   * checked: an agent switched off mid-run is off the roster from then on.
   */
  roster: () => readonly AgentCard[];
  delegator: Delegator;
  transcript: Transcript;
  workspace: Workspace;
}

export type AgentInput = {
  agent: string | string[];
  prompt: string;
  description?: string | undefined;
  kind: 'answer' | 'inspect' | 'change';
  model?: string | undefined;
  /** Full replies from existing tasks, selected by the orchestrator. */
  context_from?: string[];
  /** null explicitly selects an ordinary call outside shared conversations. */
  shared_context?: SharedContextSelection | null;
  background?: boolean;
};

/**
 * The tool that hands one task to selected coding agents, in the shape a model
 * uses to brief a subagent: which agent, the prompt it is to work from, a
 * title for the screen, and whether words or a changed workspace are wanted
 * back. The planner writes the whole brief itself — what to do, what done
 * looks like, what from the conversation the agent needs — and this tool
 * attaches only the source results explicitly selected by the planner.
 */
export class AgentTool implements Tool<AgentInput> {
  readonly name = 'agent';

  constructor(private readonly deps: AgentToolDeps) {}

  get input(): z.ZodType<AgentInput> {
    const ids = this.deps.roster().map((card) => card.id);
    // An empty roster is refused upstream; a schema still has to be buildable.
    const agent = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never();
    return z.object({
      agent: z.union([agent, z.array(agent).min(1)], { error: `Expected an agent id or nonempty array from: ${ids.join(', ')}` }),
      prompt: z.string().min(1),
      description: z.string().optional(),
      /**
       * What handsfree wants back. "answer" asks the agent to reply in words
       * and touch nothing; "change" asks it to change the workspace. Without
       * this the only call a planner can imagine is one that writes a file,
       * and "ask claude what it thinks" becomes "create thoughts.txt".
       */
      kind: z.enum(['answer', 'inspect', 'change']).default('change'),
      model: z.string().min(1).optional(),
      context_from: z.array(referenceSchema('task')).optional(),
      shared_context: SharedContextSchema.nullable().optional(),
      background: z.boolean().optional(),
    });
  }

  describe(): string {
    const cards = this.deps.roster();
    const roster = cards.map((card) => `- "${card.id}": ${card.description}`).join('\n');
    const first = cards[0]?.id ?? 'claude';
    return `agent — delegate one task inside ${this.deps.workspace.dir}.
Agents:
${roster}
Input: {"agent":"id or an array of ids","kind":"answer|inspect|change","prompt":"brief","model":"optional model","context_from":["task:1","task:2"]}.
Set background:true to start asynchronously and receive a jobId immediately. Use agent_job to wait, poll, cancel or send a follow-up. Independent background tasks may overlap; session and workspace locks still apply. Completion notifications carry the full replies back to this loop.
Returns an execution receipt and complete replies, including the actual arguments and findings. created_tasks contains task references; status:error with executed:false means no worker was called. Correct invalid references using valid_refs before retrying. Only task: references belong in context_from; record: references address transcript records and job: references address background jobs. Read the replies before deciding the next action or synthesizing a conclusion. task_result retrieves saved replies later; context_from attaches them to a worker's brief with their source agents and statuses. References must name saved tasks in this run. They do not rerun the source tasks.
Use the prompt for your own instructions or a summary you wrote after reading earlier results. Use context_from to pass exact earlier replies without copying them through your own response. Both can be combined.
For a shared collaboration, use shared_context to open/read its conversation and pass shared_context:{"conversation":"conversation:12","through":"record:24"} here. Every recipient gets the full accumulated conversation through that exact point, separate from this prompt, in a fresh session on the existing connection. Private history cannot add newer replies or unrelated topics to the selected snapshot. Your result returns the delivered shared_context and the newer conversation_head after publishing replies. Choose the next snapshot yourself.
Once a shared conversation is opened or continued for this user request, every agent call must explicitly select shared_context, including the first contribution. Wait for open to return its references before calling workers. Omission returns shared_context_required without calling any worker. For an unrelated ordinary call, explicitly set shared_context:null; it does not read or publish to a shared conversation. Use shared_context.attach to publish already saved replies that were made outside the scope, then choose its returned head.
An agent array sends independent copies of the same brief. Every recipient sees the same selected context; they do not receive each other's new replies within that call.
Choose call order and context from the user's request. When later work depends on an earlier answer, make the earlier call first, then use its task id in the next call. You may call an agent again to react to new evidence. An ended task does not establish that the user's objective is complete.
Group example: {"action":"call","tool":"agent","input":{"agent":${JSON.stringify(cards.map((card) => card.id))},"kind":"answer","prompt":"Hi? Reply briefly."}}
answer: reply only; inspect: read files and report, no commands or edits; change: implement and verify.
Use change for tasks requiring commands, including read-only git status or git diff; state any no-edit constraint in the brief. This still uses the host's current command policy.
Preserve the user's exact requirements, response length, format, constraints and file names in the prompt. Planner notes are not automatically sent to workers. Never invent a file for a question.
Omit model unless the user selected one; default, none and null mean no model override.
Prefer an agent with relevant unchanged context; its own session is reused for ordinary calls. Other agents' replies, decisions and notes are sent only when you include them in the prompt, select context_from or select shared_context. For independent opinions within a collaboration, choose the same shared snapshot before those opinions; their new replies will still be published for later calls.
Agent replies are visible to the user. Use their findings to answer the current question, including explanation or comparison when requested. Summarize relevant details without copying unrelated material.
Do not automatically retry permission refusals. When the user explicitly requests a fresh attempt, include that update in the brief; the host still checks current permissions. Report blockers; an ended turn is not proof of success.
Example: {"action":"call","tool":"agent","input":{"agent":"${first}","kind":"answer","prompt":"Evaluate the reasoning in the referenced reply and explain where you agree or disagree.","context_from":["task:1"]}}`;
  }

  async run(input: AgentInput, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.workMode === 'plan' && input.kind === 'change') return { ...toolError('plan_mode', 'Plan mode: use answer or inspect to prepare the plan. The user selects /execute before implementation.'), callsUsed: 0 };
    const active = ctx.turnId === undefined ? [] : this.deps.shared?.list(ctx.turnId) ?? [];
    if (input.shared_context === undefined && active.length) return {
      ...toolError('shared_context_required', `This user request has shared conversations. Select agent.shared_context explicitly, including for opening contributions, so their replies are published for later calls. Available heads: ${JSON.stringify(active)}. Read the scope or copy a returned conversation/through selection; the host will not choose one for you. Use shared_context:null only for an ordinary call outside the collaboration. No agent was called and no job was queued.`,
        false, active.flatMap(({ conversation, through }) => [conversation, through])), callsUsed: 0,
    };
    let shared: SharedContextSnapshot | undefined;
    try {
      if (input.shared_context) {
        if (!this.deps.shared) throw new Error('Shared conversations are unavailable here.');
        shared = this.deps.shared.resolve(input.shared_context);
      }
    } catch (error) {
      return { ...toolError('invalid_shared_context', `Cannot attach shared context: ${(error as Error).message} No agent was called.`, false,
        this.deps.shared?.list().flatMap(({ conversation, through }) => [conversation, through]) ?? []), callsUsed: 0 };
    }
    let sources: TaskOutcome[];
    try {
      sources = [...new Set(input.context_from ?? [])].map((ref) => {
        if (!this.deps.readOutcome) throw new Error('Saved task results are unavailable here.');
        return this.deps.readOutcome(referenceId('task', ref));
      });
    } catch (error) {
      const note = `Cannot attach task context: ${(error as Error).message} No agent was called.`;
      return { ...toolError('invalid_task_reference', note, false, this.deps.taskRefs?.() ?? []), note, callsUsed: 0 };
    }
    if (input.background && this.deps.jobs) {
      // Preserve the accepted context choice if another scope opens before this job runs.
      const queued = { ...input, shared_context: input.shared_context ?? null };
      const job = reference('job', this.deps.jobs.start(queued, ctx, (signal) => this.run({ ...queued, background: false }, { ...ctx, signal })));
      return { text: `Queued ${job}. No completed worker reply yet. Use agent_job to wait, poll, cancel or follow up.`,
        receipt: { status: 'pending', executed: false, created_tasks: [], job, ...this.sharedReceipt(input.shared_context) } };
    }
    if (Array.isArray(input.agent)) {
      const recipients = [...new Set(input.agent)];
      const outcomes: TaskOutcome[] = [];
      const replies: string[] = [];
      const notes: string[] = [];
      let callsUsed = 0;
      let uncertain = false;
      // A group selects the same immutable sources for independent contributions.
      // The scheduler still excludes changes and agents with native workspace tools.
      const results = await Promise.all(recipients.map(async (agent) => {
        if (ctx.signal.aborted) return { agent, skipped: true as const };
        callsUsed++;
        try { return { agent, result: await this.runSingle({ ...input, agent }, ctx, sources, shared, false) }; }
        catch (error) { return { agent, error }; }
      }));
      for (const entry of results) {
        if ('result' in entry && entry.result) {
          if (entry.result.outcome) {
            outcomes.push(entry.result.outcome);
            if (shared) this.deps.shared!.publish(shared.conversation, entry.result.outcome.taskId);
          }
          replies.push(renderToolResult(entry.result));
        } else if ('error' in entry) {
          uncertain = true;
          const message = `${entry.agent}: ${String((entry.error as Error).message ?? entry.error)}`;
          replies.push(renderToolResult(toolError('tool_exception', message, null)));
          if (!ctx.signal.aborted) notes.push(message);
        }
      }
      const skipped = results.filter((entry) => 'skipped' in entry).map((entry) => entry.agent);
      if (skipped.length) notes.push(`Not contacted (cancelled): ${skipped.join(', ')}.`);
      return {
        text: [...replies, ...notes].join('\n\n'),
        receipt: { status: ctx.signal.aborted ? 'cancelled' : notes.length || outcomes.some((outcome) => outcome.status !== 'done') ? 'error' : 'ok',
          executed: outcomes.some((outcome) => this.executed(outcome)) ? true : uncertain ? null : false,
          created_tasks: outcomes.map((outcome) => reference('task', outcome.taskId)), ...this.sharedReceipt(input.shared_context) },
        outcomes,
        callsUsed,
        ...(notes.length ? { note: notes.join('\n') } : {}),
        halt: ctx.signal.aborted,
      };
    }
    return this.runSingle({ ...input, agent: input.agent }, ctx, sources, shared);
  }

  private async runSingle(input: AgentInput & { agent: string }, ctx: ToolContext, sources: TaskOutcome[], shared?: SharedContextSnapshot, publish = true): Promise<ToolResult> {
    const outcome = await this.deps.delegator.delegate(
      {
        agentId: input.agent,
        kind: input.kind,
        prompt: input.prompt,
        ...(sources.length ? { context: sources } : {}),
        ...(shared ? { sharedContext: shared } : {}),
        title: input.description,
        model: input.model && !/^(default|none|null)$/i.test(input.model) ? input.model : undefined,
      },
      ctx.signal,
    );
    this.deps.onOutcome?.(outcome);
    if (shared && publish) this.deps.shared!.publish(shared.conversation, outcome.taskId);
    const result: ToolResult = {
      text: renderOutcome(outcome, this.deps.workspace.dir, { relayMessage: true }),
      receipt: { status: outcome.status === 'done' ? 'ok' : outcome.status === 'cancelled' ? 'cancelled' : 'error',
        executed: this.executed(outcome), created_tasks: [reference('task', outcome.taskId)], ...this.sharedReceipt(input.shared_context) },
      outcome,
      callsUsed: 1,
      // Cancellation stops the turn. Other failures return to the planner
      // to assess the blocker and, where possible, choose another worker.
      halt: outcome.status === 'cancelled',
    };
    this.recordUsage(outcome, result);
    return result;
  }

  private sharedReceipt(selection?: SharedContextSelection | null) {
    if (!selection) return {};
    const current = this.deps.shared?.list().find((item) => item.conversation === selection.conversation);
    return { shared_context: selection,
      ...(current ? { conversation_head: { conversation: current.conversation, through: current.through } } : {}) };
  }

  private executed(outcome: TaskOutcome): boolean {
    return outcome.status === 'done' || this.deps.transcript.all().some((record) => record.type === 'delegation' && record.taskId === outcome.taskId);
  }

  /**
   * The full reply is evidence for the next decision, even when a worker also
   * supplied a structured report. A status summary cannot replace its argument.
   */
  private recordUsage(outcome: TaskOutcome, result: ToolResult): void {
    this.deps.transcript.append({
      type: 'usage',
      purpose: 'task',
      taskId: outcome.taskId,
      promptChars: outcome.briefChars ?? 0,
      replyChars: outcome.message.length,
      relayedChars: renderToolResult(result).length,
    });
  }
}
