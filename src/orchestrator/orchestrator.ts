import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { AgentName, Config } from '../config/schema.js';
import { LlmClient, type ChatClient, type ChatMessage } from '../llm/client.js';
import { parseAction, type Action } from '../llm/protocol.js';
import { claudeAdapter } from '../agents/claude.js';
import { geminiAdapter } from '../agents/gemini.js';
import { codexAdapter } from '../agents/codex.js';
import { runCli } from '../agents/runner.js';
import type { AgentAdapter, DelegationResult, TaskStatus } from '../agents/types.js';
import { Session } from '../workspace/session.js';
import {
  buildBrief,
  buildDelegatePrompt,
  buildSummaryRequest,
  buildSummarySystemPrompt,
  buildSystemPrompt,
} from './prompts.js';
import { classifyOutcome } from './outcome.js';
import { renderTurnLedger, type TurnTask } from './turn.js';

export interface OrchestratorEvents {
  assistant_text: [text: string];
  task_started: [info: { id: number; agent: AgentName; task: string }];
  task_output_chunk: [info: { id: number; agent: AgentName; chunk: string }];
  task_finished: [info: { id: number; agent: AgentName; status: TaskStatus; summary: string }];
  turn_done: [];
  error: [message: string];
}

const ADAPTERS: Record<AgentName, AgentAdapter> = {
  claude: claudeAdapter,
  gemini: geminiAdapter,
  codex: codexAdapter,
};

/**
 * A small local model told to emit JSON actions tends to keep emitting them even
 * when asked for prose. Unwrap a `respond` action; treat anything else as unusable
 * so the caller falls back to the deterministic ledger.
 */
function extractProse(reply: string): string {
  const text = reply.trim();
  if (text === '') return '';
  if (!text.startsWith('{')) return text;
  const parsed = parseAction(text);
  if (parsed.ok && parsed.action.action === 'respond') return parsed.action.message.trim();
  return '';
}

export interface OrchestratorDeps {
  /** Stand-in chat client. Tests use it; production always builds a real one. */
  llm?: ChatClient;
}

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  readonly session: Session;
  private llm: ChatClient;
  private messages: ChatMessage[] = [];
  private turnAbort: AbortController | undefined;

  constructor(private config: Config, runDir?: string, deps: OrchestratorDeps = {}) {
    super();
    this.llm = deps.llm ?? new LlmClient(config.llm);
    this.session = new Session(config.workspaceRoot, runDir);
    this.messages.push({ role: 'system', content: buildSystemPrompt(config) });
  }

  /** Cancel whatever the current turn is waiting on — an LLM call or a running CLI. */
  cancelActiveTask(): void {
    this.turnAbort?.abort();
  }

  /** Drop conversation history, keeping the session workspace. */
  resetConversation(): void {
    this.messages = [{ role: 'system', content: buildSystemPrompt(this.config) }];
  }

  async handleUserMessage(text: string): Promise<void> {
    this.pushMessage({ role: 'user', content: text });
    const { maxTurns, maxDelegationsPerMessage } = this.config.orchestrator;
    const turnTasks: TurnTask[] = [];
    const notes: string[] = [];
    let delegations = 0;
    let blockedRetries = 0;
    let responded = false;
    let turn = 0;

    this.turnAbort = new AbortController();
    const signal = this.turnAbort.signal;

    try {
      for (; turn < maxTurns; turn++) {
        const action = await this.nextAction(signal);
        if (!action) {
          notes.push('The orchestrator model did not produce a valid next step.');
          break;
        }

        if (action.action === 'respond') {
          this.emit('assistant_text', action.message);
          responded = true;
          break;
        }

        if (delegations >= maxDelegationsPerMessage) {
          notes.push(`Stopped at the delegation limit of ${maxDelegationsPerMessage} for one message.`);
          break;
        }
        if (!this.config.agents[action.agent].enabled) {
          const summary = `Agent "${action.agent}" is disabled.`;
          this.pushResult({ status: 'error', summary, exitCode: undefined });
          notes.push(summary);
          continue;
        }

        delegations += 1;
        const { result, record } = await this.delegate(action, signal);
        turnTasks.push(record);
        // Push before any early exit, so the model always sees the outcome it caused.
        this.pushResult(result);

        if (result.status === 'cancelled') {
          notes.push('You cancelled the task.');
          break;
        }
        if (result.status === 'blocked_by_permissions') {
          blockedRetries += 1;
          if (blockedRetries > 1) {
            // Invariant: never widen scope in response to a denial. Report instead.
            notes.push(
              'Still blocked by permissions after one rephrase — this would need broader approval than handsfree grants.',
            );
            break;
          }
        }
      }
      if (turn >= maxTurns && !responded) {
        notes.push(`Stopped after ${maxTurns} orchestrator turns without a final answer.`);
      }
    } catch (err) {
      const message = signal.aborted ? 'Cancelled.' : (err as Error).message;
      if (!signal.aborted) this.emit('error', message);
      notes.push(signal.aborted ? 'You cancelled the turn.' : `The turn stopped early: ${message}`);
    } finally {
      // A turn that delegated work always reports back, whatever went wrong above.
      if (!responded) {
        if (turnTasks.length > 0) {
          const summary = await this.summarizeTurn(text, turnTasks, notes, signal.aborted);
          this.pushMessage({
            role: 'assistant',
            content: JSON.stringify({ action: 'respond', message: summary }),
          });
          this.emit('assistant_text', summary);
        } else if (notes.length > 0) {
          this.emit('assistant_text', notes.join(' '));
        }
      }
      this.turnAbort = undefined;
      this.emit('turn_done');
    }
  }

  /**
   * Ask the model for prose about what just happened, and fall back to a ledger
   * built purely from recorded outcomes. Summarising must never be the reason a
   * turn reports nothing back, so this method does not throw.
   */
  private async summarizeTurn(
    userMessage: string,
    tasks: TurnTask[],
    notes: string[],
    cancelled: boolean,
  ): Promise<string> {
    const ledger = renderTurnLedger(tasks, notes);
    // A cancelled turn should stop now, not wait on one more model round-trip.
    if (cancelled) return ledger;
    try {
      const reply = await this.llm.chat(
        [
          { role: 'system', content: buildSummarySystemPrompt() },
          { role: 'user', content: buildSummaryRequest(userMessage, tasks, notes) },
        ],
        { json: false },
      );
      const prose = extractProse(reply);
      if (prose) return prose;
    } catch {
      // Endpoint down, timed out, or refused — the ledger still tells the truth.
    }
    return ledger;
  }

  private async nextAction(signal: AbortSignal): Promise<Action | null> {
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt =
        attempt === 0
          ? this.messages
          : [
              ...this.messages,
              {
                role: 'user' as const,
                content: `Your previous reply was not valid. ${lastError} Reply with ONLY one JSON object matching the schema.`,
              },
            ];
      const reply = await this.llm.chat(prompt, { signal });
      const parsed = parseAction(reply);
      if (parsed.ok) {
        this.pushMessage({ role: 'assistant', content: JSON.stringify(parsed.action) });
        return parsed.action;
      }
      lastError = parsed.error;
    }
    return null;
  }

  private async delegate(
    action: Extract<Action, { action: 'delegate' }>,
    signal: AbortSignal,
  ): Promise<{ result: DelegationResult; record: TurnTask }> {
    const { agent, task, done_when } = action;
    const adapter = ADAPTERS[agent];
    const agentCfg = this.config.agents[agent];
    const taskPaths = this.session.createTask(agent);
    const brief = buildBrief(agent, task, done_when, taskPaths, this.session.relative(this.session.contextFile));
    fs.writeFileSync(taskPaths.briefFile, brief);

    const prompt = buildDelegatePrompt(taskPaths, this.session.runDir);
    const invocation = adapter.buildInvocation(prompt, taskPaths, this.session.runDir, this.config);

    this.emit('task_started', { id: taskPaths.id, agent, task });
    const startedAt = Date.now();
    const run = await runCli(invocation, {
      cwd: this.session.runDir,
      timeoutMs: agentCfg.timeoutMs,
      signal,
      onChunk: (chunk) => this.emit('task_output_chunk', { id: taskPaths.id, agent, chunk }),
    });
    const durationMs = Date.now() - startedAt;

    this.session.writeRaw(taskPaths, run.output);
    const parsed = adapter.parseOutput({ stdout: run.stdout, stderr: run.stderr }, taskPaths);
    const status = classifyOutcome(run, parsed);
    const summaryFull = this.session.ensureResult(taskPaths, parsed.finalMessage);
    const summary = summaryFull.slice(0, this.config.orchestrator.maxResultChars);
    const resultPath = this.session.relative(taskPaths.resultFile);

    this.session.appendContext(
      `- Task ${taskPaths.id} (${agent}): ${status} — ${task.slice(0, 120)} — result: ${resultPath}`,
    );
    this.emit('task_finished', { id: taskPaths.id, agent, status, summary });

    const denialDetail = [...parsed.denials, ...parsed.denialHints].join('; ');
    return {
      result: {
        status,
        summary:
          status === 'blocked_by_permissions' && denialDetail
            ? `${summary}\nDenied: ${denialDetail}`
            : summary,
        exitCode: run.exitCode,
      },
      record: { id: taskPaths.id, agent, task, status, summary, durationMs, resultPath },
    };
  }

  private pushResult(result: DelegationResult): void {
    this.pushMessage({
      role: 'user',
      content: JSON.stringify({
        task_result: {
          status: result.status,
          summary: result.summary.slice(0, this.config.orchestrator.maxResultChars),
        },
      }),
    });
  }

  private pushMessage(message: ChatMessage): void {
    this.messages.push(message);
    // Keep the system prompt and the most recent window. Local models have small
    // context windows, and an untrimmed history degrades them without any error.
    const max = this.config.orchestrator.maxHistoryMessages;
    if (this.messages.length > max + 1) {
      const [system, ...rest] = this.messages;
      this.messages = [system, ...rest.slice(rest.length - max)];
    }
  }
}
