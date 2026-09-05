import { z } from 'zod';
import type { Delegator } from '../../execution/delegate.js';
import { renderOutcome, type TaskOutcome } from '../../results/outcome.js';
import type { Transcript } from '../../../workspace/transcript.js';
import type { Workspace } from '../../../workspace/workspace.js';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { AgentJobs } from '../jobs.js';

export interface AgentCard {
  id: string;
  /** What the agent is for: its configured role, or the launch profile's note. */
  description: string;
}

export interface AgentToolDeps {
  jobs?: AgentJobs;
  onOutcome?: (outcome: TaskOutcome) => void;
  readOutcome?: (taskId: number) => TaskOutcome;
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
  context_from?: number[];
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
      context_from: z.array(z.number().int().positive()).optional(),
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
Input: {"agent":"id or an array of ids","kind":"answer|inspect|change","prompt":"brief","model":"optional model","context_from":[1,2]}.
Set background:true to start asynchronously and receive a jobId immediately. Use agent_job to wait, poll, cancel or send a follow-up. Independent background tasks may overlap; session and workspace locks still apply. Completion notifications carry the full replies back to this loop.
Returns task ids, execution statuses and complete replies, including the actual arguments and findings. Read those replies before deciding the next action or synthesizing a conclusion. task_result retrieves saved replies later; context_from attaches them to a worker's brief with their source agents and statuses. References must name saved tasks in this run. They do not rerun the source tasks.
Use the prompt for your own instructions or a summary you wrote after reading earlier results. Use context_from to pass exact earlier replies without copying them through your own response. Both can be combined.
An agent array sends independent copies of the same brief. Every recipient sees the same selected context; they do not receive each other's new replies within that call.
Choose call order and context from the user's request. When later work depends on an earlier answer, make the earlier call first, then use its task id in the next call. You may call an agent again to react to new evidence. An ended task does not establish that the user's objective is complete.
Group example: {"action":"call","tool":"agent","input":{"agent":${JSON.stringify(cards.map((card) => card.id))},"kind":"answer","prompt":"Hi? Reply briefly."}}
answer: reply only; inspect: read files and report, no commands or edits; change: implement and verify.
Use change for tasks requiring commands, including read-only git status or git diff; state any no-edit constraint in the brief. This still uses the host's current command policy.
Preserve the user's exact requirements, response length, format, constraints and file names in the prompt. Planner notes are not automatically sent to workers. Never invent a file for a question.
Omit model unless the user selected one; default, none and null mean no model override.
Prefer an agent with relevant unchanged context; its own session is reused. Other agents' replies, decisions and notes are sent only when you include them in the prompt or select context_from. For independent opinions, omit context_from and avoid sharing the other participants' positions.
Agent replies are visible to the user. Use their findings to answer the current question, including explanation or comparison when requested. Summarize relevant details without copying unrelated material.
Do not automatically retry permission refusals. When the user explicitly requests a fresh attempt, include that update in the brief; the host still checks current permissions. Report blockers; an ended turn is not proof of success.
Example: {"action":"call","tool":"agent","input":{"agent":"${first}","kind":"answer","prompt":"Evaluate the reasoning in the referenced reply and explain where you agree or disagree.","context_from":[1]}}`;
  }

  async run(input: AgentInput, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.workMode === 'plan' && input.kind === 'change') return { text: 'Plan mode: use answer or inspect to prepare the plan. The user selects /execute before implementation.', callsUsed: 0 };
    if (input.background && this.deps.jobs) {
      const jobId = this.deps.jobs.start(input, ctx, (signal) => this.run({ ...input, background: false }, { ...ctx, signal }));
      return { text: `Started agent job ${jobId}. Use agent_job with this jobId to wait, poll, cancel or follow up.` };
    }
    let sources: TaskOutcome[];
    try {
      sources = [...new Set(input.context_from ?? [])].map((taskId) => {
        if (!this.deps.readOutcome) throw new Error('Saved task results are unavailable here.');
        return this.deps.readOutcome(taskId);
      });
    } catch (error) {
      const note = `Cannot attach task context: ${(error as Error).message} No agent was called.`;
      return { text: note, note, callsUsed: 0 };
    }
    if (Array.isArray(input.agent)) {
      const recipients = [...new Set(input.agent)];
      const outcomes: TaskOutcome[] = [];
      const replies: string[] = [];
      const notes: string[] = [];
      let callsUsed = 0;
      for (const agent of recipients) {
        if (ctx.signal.aborted) break;
        callsUsed++;
        try {
          const result = await this.runSingle({ ...input, agent }, ctx, sources);
          if (result.outcome) outcomes.push(result.outcome);
          replies.push(result.text);
        } catch (err) {
          if (!ctx.signal.aborted) notes.push(`${agent}: ${(err as Error).message}`);
        }
      }
      const skipped = recipients.slice(callsUsed);
      if (skipped.length) notes.push(`Not contacted (cancelled): ${skipped.join(', ')}.`);
      return {
        text: [...replies, ...notes].join('\n\n'),
        outcomes,
        callsUsed,
        ...(notes.length ? { note: notes.join('\n') } : {}),
        halt: ctx.signal.aborted,
      };
    }
    return this.runSingle({ ...input, agent: input.agent }, ctx, sources);
  }

  private async runSingle(input: AgentInput & { agent: string }, ctx: ToolContext, sources: TaskOutcome[]): Promise<ToolResult> {
    const outcome = await this.deps.delegator.delegate(
      {
        agentId: input.agent,
        kind: input.kind,
        prompt: input.prompt,
        ...(sources.length ? { context: sources } : {}),
        title: input.description,
        model: input.model && !/^(default|none|null)$/i.test(input.model) ? input.model : undefined,
      },
      ctx.signal,
    );
    this.deps.onOutcome?.(outcome);
    return {
      text: this.relay(outcome),
      outcome,
      callsUsed: 1,
      // Cancellation stops the turn. Other failures return to the planner
      // to assess the blocker and, where possible, choose another worker.
      halt: outcome.status === 'cancelled',
    };
  }

  /**
   * The full reply is evidence for the next decision, even when a worker also
   * supplied a structured report. A status summary cannot replace its argument.
   */
  private relay(outcome: TaskOutcome): string {
    const { transcript, workspace } = this.deps;
    const result = renderOutcome(outcome, workspace.dir, { relayMessage: true });
    transcript.append({
      type: 'usage',
      purpose: 'task',
      taskId: outcome.taskId,
      promptChars: outcome.briefChars ?? 0,
      replyChars: outcome.message.length,
      relayedChars: result.length,
    });
    return result;
  }
}
