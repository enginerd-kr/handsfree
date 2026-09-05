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
  agent: string;
  prompt: string;
  description?: string | undefined;
  kind: 'answer' | 'inspect' | 'change';
  model?: string | undefined;
};

/**
 * The tool that hands one task to one coding agent, in the shape a model
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
    const agent = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.string().min(1);
    return z.object({
      agent,
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
Input: {"agent":"id","kind":"answer|inspect|change","prompt":"brief","model":"optional model"}.
answer: reply only; inspect: read files and report, no commands or edits; change: implement and verify.
Preserve the user's exact requirements and file names. Never invent a file for a question.
Prefer an agent with relevant unchanged context; sessions are reused and receive relevant handoffs.
Agent replies are delivered to the user separately; return only a short status, without repeating them.
Permission refusals are final. Report blockers; an ended turn is not proof of success.
Example: {"action":"call","tool":"agent","input":{"agent":"${first}","kind":"change","prompt":"Create notes.txt containing exactly hello world."}}`;
  }

  async run(input: AgentInput, ctx: ToolContext): Promise<ToolResult> {
    const outcome = await this.deps.delegator.delegate(
      {
        agentId: input.agent,
        kind: input.kind,
        prompt: input.prompt,
        title: input.description,
        model: input.model,
      },
      ctx.signal,
    );
    this.deps.onOutcome?.(outcome);
    return {
      text: this.relay(outcome),
      outcome,
      // A cancelled task is a turn the user stopped; an agent that died
      // cannot be handed the next task either way.
      halt: outcome.status === 'cancelled' || outcome.status === 'error' || outcome.status === 'budget_exceeded',
    };
  }

  /**
   * What the planner is handed when a task ends: the head, the report's
   * summary and open items, and — unless the config asks for the whole reply
   * — a reminder that the user has already seen the rest. Written down as it
   * goes out, against what the agent actually said, so `/cost` can say what
   * the report contract saved.
   */
  private relay(outcome: TaskOutcome): string {
    const { config, transcript, workspace } = this.deps;
    const relayMessage = config.orchestration.relayAnswers;
    const lines = [renderOutcome(outcome, workspace.dir, { relayMessage, maxChars: config.limits.maxResultChars - 120 })];
    if (!relayMessage && outcome.message) {
      lines.push(`(The user has already seen ${outcome.agentId}'s full reply on screen; do not repeat it.)`);
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
