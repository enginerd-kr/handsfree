import type { StopReason } from '@agentclientprotocol/sdk';
import type { Config } from '../config/schema.js';
import { trimHistory, type ChatClient, type ChatMessage } from '../brain/client.js';
import { narrate } from '../brain/narrate.js';
import { nextStep, planSystemPrompt, type AgentCard } from '../brain/plan.js';
import { SessionUnresponsiveError } from '../host/session.js';
import type { AgentPool } from '../host/pool.js';
import type { Transcript } from '../workspace/transcript.js';
import type { Workspace } from '../workspace/workspace.js';
import { summarise, renderOutcome, type TaskOutcome } from './outcome.js';
import { buildBrief } from './prompts.js';

export interface ConversationDeps {
  config: Config;
  pool: AgentPool;
  transcript: Transcript;
  workspace: Workspace;
  llm: ChatClient | undefined;
}

/**
 * One user turn: plan, delegate, report. Everything it learns goes into the
 * transcript as it happens, and the turn is only over once the user has been
 * told what became of the work — including when the planning model fails, the
 * agent dies, or the user cancels half way through.
 */
export class Conversation {
  private messages: ChatMessage[] = [];
  private taskCounter = 0;
  private turn: AbortController | undefined;
  private readonly briefed = new Set<string>();

  constructor(private readonly deps: ConversationDeps) {}

  get isBusy(): boolean {
    return this.turn !== undefined;
  }

  cancel(): void {
    this.turn?.abort();
  }

  reset(): void {
    this.messages = [];
  }

  async send(text: string): Promise<void> {
    const { config, transcript, workspace } = this.deps;
    transcript.append({ type: 'user', text });

    const agents = this.deps.pool.available();
    if (agents.length === 0) {
      transcript.append({ type: 'assistant', text: 'No agents are enabled in the configuration.' });
      return;
    }
    this.ensureSystemPrompt(agents);
    this.push({ role: 'user', content: text });

    const turn = new AbortController();
    this.turn = turn;
    const outcomes: TaskOutcome[] = [];
    const notes: string[] = [];
    let answered = false;
    let delegations = 0;

    try {
      for (let step = 0; step < config.limits.maxPlanSteps; step++) {
        if (turn.signal.aborted) break;

        const planned = await this.plan(agents, turn.signal);
        if (!planned.ok) {
          notes.push(`The local model did not produce a usable next step (${planned.error}).`);
          break;
        }
        this.push({ role: 'assistant', content: JSON.stringify(planned.step) });

        if (planned.step.action === 'answer') {
          transcript.append({ type: 'assistant', text: planned.step.message });
          answered = true;
          break;
        }

        if (delegations >= config.limits.maxDelegationsPerTurn) {
          notes.push(`Stopped at the limit of ${config.limits.maxDelegationsPerTurn} tasks per message.`);
          break;
        }
        delegations++;

        const outcome = await this.delegate(
          planned.step.agent,
          planned.step.task,
          planned.step.done_when,
          turn.signal,
        );
        outcomes.push(outcome);
        this.push({
          role: 'user',
          content: `TASK RESULT\n${renderOutcome(outcome, workspace.dir).slice(0, config.limits.maxResultChars)}`,
        });

        if (outcome.status === 'cancelled') {
          notes.push('You cancelled the task.');
          break;
        }
        if (outcome.status === 'error') break;
      }
    } catch (err) {
      const message = turn.signal.aborted ? 'Cancelled.' : (err as Error).message;
      notes.push(turn.signal.aborted ? 'You cancelled the turn.' : `The turn stopped: ${message}`);
    } finally {
      if (!answered) {
        const summary =
          outcomes.length > 0 || notes.length > 0
            ? await narrate(
                this.deps.llm,
                { userMessage: text, outcomes, notes, workspaceDir: workspace.dir },
                turn.signal.aborted ? undefined : turn.signal,
              )
            : 'Nothing to do.';
        this.push({ role: 'assistant', content: summary });
        transcript.append({ type: 'assistant', text: summary });
      }
      this.turn = undefined;
    }
  }

  private async plan(agents: string[], signal: AbortSignal) {
    if (!this.deps.llm) {
      return { ok: false as const, error: 'no local model is configured' };
    }
    try {
      return await nextStep(this.deps.llm, this.messages, agents, signal);
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }

  private async delegate(
    agentId: string,
    task: string,
    doneWhen: string | undefined,
    signal: AbortSignal,
  ): Promise<TaskOutcome> {
    const { config, pool, transcript, workspace } = this.deps;
    const taskId = ++this.taskCounter;
    const startedAt = Date.now();

    let session;
    try {
      session = await pool.session(agentId);
    } catch (err) {
      const failed = summarise(taskId, agentId, task, 'unresponsive', [], Date.now() - startedAt);
      transcript.append({ type: 'note', level: 'error', text: (err as Error).message });
      return { ...failed, message: (err as Error).message };
    }

    transcript.append({
      type: 'delegation',
      taskId,
      agentId,
      sessionId: session.sessionId,
      task,
    });

    const first = !this.briefed.has(agentId);
    this.briefed.add(agentId);
    const brief = buildBrief({ task, doneWhen, workspaceDir: workspace.dir, first });

    let stopReason: StopReason | 'unresponsive';
    try {
      stopReason = await session.prompt(brief, {
        turnTimeoutMs: config.limits.turnTimeoutMs,
        idleTimeoutMs: config.limits.idleTimeoutMs,
        cancelGraceMs: config.limits.cancelGraceMs,
        signal,
      });
    } catch (err) {
      stopReason = 'unresponsive';
      transcript.append({
        type: 'note',
        level: 'error',
        text: (err as Error).message,
      });
      if (err instanceof SessionUnresponsiveError) {
        // A session that will not end its turn cannot be trusted with the next
        // one; drop the process so the following task starts clean.
        await pool.discard(agentId);
      }
    }

    transcript.append({
      type: 'stop',
      taskId,
      agentId,
      sessionId: session.sessionId,
      stopReason: stopReason === 'unresponsive' ? 'cancelled' : stopReason,
    });

    return summarise(
      taskId,
      agentId,
      task,
      stopReason,
      transcript.forTask(taskId),
      Date.now() - startedAt,
    );
  }

  private ensureSystemPrompt(agents: string[]): void {
    const cards: AgentCard[] = agents.map((id) => ({
      id,
      description: this.deps.config.agents[id]?.note || 'coding agent',
    }));
    const system = planSystemPrompt(cards, this.deps.workspace.dir);
    if (this.messages[0]?.role === 'system') this.messages[0] = { role: 'system', content: system };
    else this.messages.unshift({ role: 'system', content: system });
  }

  private push(message: ChatMessage): void {
    this.messages.push(message);
    this.messages = trimHistory(this.messages, this.deps.config.llm.maxHistoryMessages);
  }
}
