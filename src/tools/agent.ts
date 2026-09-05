import { z } from 'zod';
import type { Config } from '../config/schema.js';
import type { Delegator } from '../orchestrator/delegate.js';
import { renderOutcome, type TaskOutcome } from '../orchestrator/outcome.js';
import type { Transcript } from '../workspace/transcript.js';
import type { Workspace } from '../workspace/workspace.js';
import type { Tool, ToolContext, ToolResult } from './tool.js';

export interface AgentCard {
  id: string;
  /** What the agent is for: its configured role, or the launch profile's note. */
  description: string;
}

export interface AgentToolDeps {
  onOutcome?: (outcome: TaskOutcome) => void;
  workingContext?: () => string;
  /**
   * Who can be called, read each time the tool is described or a call is
   * checked: an agent switched off mid-run is off the roster from then on.
   */
  roster: () => readonly AgentCard[];
  delegator: Delegator;
  config: Config;
  transcript: Transcript;
  workspace: Workspace;
}

export type AgentInput = {
  agent: string | string[];
  prompt: string;
  description?: string | undefined;
  kind: 'answer' | 'inspect' | 'change';
  model?: string | undefined;
};

/**
 * The tool that hands one task to selected coding agents, in the shape a model
 * uses to brief a subagent: which agent, the prompt it is to work from, a
 * title for the screen, and whether words or a changed workspace are wanted
 * back. The planner writes the whole brief itself — what to do, what done
 * looks like, what from the conversation the agent needs — and this tool
 * adds only what the planner cannot know: the ground rules, and what the
 * other agents did since.
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
    });
  }

  describe(): string {
    const cards = this.deps.roster();
    const roster = cards.map((card) => `- "${card.id}": ${card.description}`).join('\n');
    const first = cards[0]?.id ?? 'claude';
    return `agent — delegate one task inside ${this.deps.workspace.dir}.
Agents:
${roster}
Input: {"agent":"id or an array of ids","kind":"answer|inspect|change","prompt":"brief","model":"optional model"}.
For the same request to multiple agents, select every intended recipient in one agent array. For all agents, include every listed id. The host calls each independently before returning; never ask one agent to speak for the others.
For different tasks, make separate calls with the appropriate briefs.
Group example: {"action":"call","tool":"agent","input":{"agent":${JSON.stringify(cards.map((card) => card.id))},"kind":"answer","prompt":"Hi? Reply briefly."}}
answer: reply only; inspect: read files and report, no commands or edits; change: implement and verify.
Preserve the user's exact requirements and file names. Never invent a file for a question.
Omit model unless the user selected one; default, none and null mean no model override.
Prefer an agent with relevant unchanged context; sessions are reused and receive relevant handoffs.
Agent replies are visible to the user. Use their findings to answer the current question, including explanation or comparison when requested. Summarize relevant details without copying unrelated material.
Permission refusals are final. Report blockers; an ended turn is not proof of success.
Example: {"action":"call","tool":"agent","input":{"agent":"${first}","kind":"change","prompt":"Create notes.txt containing exactly hello world."}}`;
  }

  async run(input: AgentInput, ctx: ToolContext): Promise<ToolResult> {
    if (Array.isArray(input.agent)) {
      const recipients = [...new Set(input.agent)];
      const limit = Math.min(ctx.remainingCalls ?? this.deps.config.limits.maxDelegationsPerTurn, this.deps.config.limits.maxDelegationsPerTurn);
      const outcomes: TaskOutcome[] = [];
      const replies: string[] = [];
      const notes: string[] = [];
      let callsUsed = 0;
      for (const agent of recipients) {
        if (ctx.signal.aborted || callsUsed >= limit) break;
        callsUsed++;
        try {
          const result = await this.runSingle({ ...input, agent }, ctx,
            Math.max(256, Math.floor(this.deps.config.limits.maxResultChars / Math.max(1, Math.min(recipients.length, limit)))));
          if (result.outcome) outcomes.push(result.outcome);
          replies.push(result.text);
        } catch (err) {
          if (!ctx.signal.aborted) notes.push(`${agent}: ${(err as Error).message}`);
        }
      }
      const skipped = recipients.slice(callsUsed);
      if (skipped.length) notes.push(`Not contacted (${ctx.signal.aborted ? 'cancelled' : 'delegation limit reached'}): ${skipped.join(', ')}.`);
      return {
        text: [...replies, ...notes].join('\n\n'),
        outcomes,
        callsUsed,
        ...(notes.length ? { note: notes.join('\n') } : {}),
        halt: ctx.signal.aborted,
      };
    }
    if (ctx.remainingCalls !== undefined && ctx.remainingCalls <= 0) {
      const note = `Reached the delegation limit of ${this.deps.config.limits.maxDelegationsPerTurn}; ${input.agent} was not contacted. Analyze existing results and report remaining work.`;
      return { text: note, note, callsUsed: 0 };
    }
    return this.runSingle({ ...input, agent: input.agent }, ctx);
  }

  private async runSingle(input: AgentInput & { agent: string }, ctx: ToolContext, maxChars = this.deps.config.limits.maxResultChars): Promise<ToolResult> {
    const outcome = await this.deps.delegator.delegate(
      {
        agentId: input.agent,
        kind: input.kind,
        prompt: [input.prompt, this.deps.workingContext?.()].filter(Boolean).join('\n\n'),
        title: input.description,
        model: input.model && !/^(default|none|null)$/i.test(input.model) ? input.model : undefined,
      },
      ctx.signal,
    );
    this.deps.onOutcome?.(outcome);
    return {
      text: this.relay(outcome, maxChars),
      outcome,
      callsUsed: 1,
      // Cancellation stops the turn. Other failures return to the planner
      // to assess the blocker and, where possible, choose another worker.
      halt: outcome.status === 'cancelled',
    };
  }

  /**
   * What the planner is handed when a task ends: the head, the report's
   * summary and open items, and — unless the config asks for the whole reply
   * — a reminder that the user has already seen the rest. Written down as it
   * goes out, against what the agent actually said, so `/cost` can say what
   * the report contract saved.
   */
  private relay(outcome: TaskOutcome, maxChars: number): string {
    const { config, transcript, workspace } = this.deps;
    const relayMessage = config.orchestration.relayAnswers;
    const lines = [renderOutcome(outcome, workspace.dir, { relayMessage, maxChars: Math.max(1, maxChars - 120) })];
    if (!relayMessage && outcome.message) {
      lines.push(`(${outcome.agentId}'s full reply is visible to the user; use task_result for details missing from this report.)`);
    }
    const result = lines.join('\n');
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
