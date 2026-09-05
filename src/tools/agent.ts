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
  kind: 'answer' | 'change';
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
      kind: z.enum(['answer', 'change']).default('change'),
      model: z.string().min(1).optional(),
    });
  }

  describe(): string {
    const cards = this.deps.roster();
    const roster = cards.map((card) => `- "${card.id}": ${card.description}`).join('\n');
    const first = cards[0]?.id ?? 'claude';
    return `agent — hand one task to one coding agent.
Input: {"agent":"<agent id>","kind":"answer|change","description":"<a few words naming the task>","prompt":"<the brief>"}

Agents:
${roster}

How the agents work:
- They share a workspace directory: ${this.deps.workspace.dir}. Everything they create lives there.
- Every file they touch and every command they run is approved or refused by handsfree, not by them. A refusal is final; asking again will not change it.
- Each agent keeps its memory between tasks, so a follow-up task can refer to what it just did.
- Each agent is told which files the other agents changed since it last worked, what they said they did, and what they decided. A brief need not repeat that.
- They can also just talk. Asking one a question is a task; its reply comes back to you as a short report.
- Everything an agent says is shown to the user as it is said. You never need to repeat it.

Rules for calling it:
- Call it for work that needs an agent: changing files or code, and anything the user wants a specific agent to say.
- Choose the agent by what it is for. Where two would both suit, choose the one that already has the files the task concerns: its session still holds them, so it reads less to begin.
- "kind" says what you want back. "answer": the agent's words; it creates nothing. Use it whenever the user says ask, tell, question, or wants an agent's opinion. "change": the workspace changed.
- Write "prompt" as a short imperative brief: exact file names and exact content when the user gave them, what done looks like, and any fact from the conversation the agent needs that the run state does not show.
- Never invent a file. Name a file only when the user named one or clearly asked for one. A question is not a file.
- The result tells you the task's status, the files it touched, what was refused, and the agent's own summary and open points.

Examples:
User: make notes.txt containing hello world
{"action":"call","tool":"agent","input":{"agent":"${first}","kind":"change","description":"create notes.txt","prompt":"Create notes.txt containing exactly: hello world. Done when notes.txt exists with that content."}}
User: ask ${first} 안녕?
{"action":"call","tool":"agent","input":{"agent":"${first}","kind":"answer","description":"greet ${first}","prompt":"안녕?"}}
User: what does ${first} think of this approach?
{"action":"call","tool":"agent","input":{"agent":"${first}","kind":"answer","description":"${first}'s view","prompt":"What do you think of this approach?"}}`;
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
    return {
      text: this.relay(outcome),
      outcome,
      // A cancelled task is a turn the user stopped; an agent that died
      // cannot be handed the next task either way.
      halt: outcome.status === 'cancelled' || outcome.status === 'error',
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
    const lines = [renderOutcome(outcome, workspace.dir, { relayMessage })];
    if (!relayMessage && outcome.message) {
      lines.push(`(The user has already seen ${outcome.agentId}'s full reply on screen; do not repeat it.)`);
    }
    const result = lines.join('\n').slice(0, config.limits.maxResultChars);
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
