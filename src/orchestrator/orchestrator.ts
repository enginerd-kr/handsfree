import { EventEmitter } from 'node:events';
import type { AgentName, Config } from '../config/schema.js';
import { LlmClient, type ChatMessage } from '../llm/client.js';
import { parseAction, type Action } from '../llm/protocol.js';
import { claudeAdapter } from '../agents/claude.js';
import { geminiAdapter } from '../agents/gemini.js';
import { codexAdapter } from '../agents/codex.js';
import { runCli } from '../agents/runner.js';
import type { AgentAdapter, DelegationResult, TaskStatus } from '../agents/types.js';
import { Session } from '../workspace/session.js';
import { buildBrief, buildDelegatePrompt, buildSystemPrompt } from './prompts.js';
import { classifyOutcome } from './outcome.js';

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

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  readonly session: Session;
  private llm: LlmClient;
  private messages: ChatMessage[] = [];
  private abortController: AbortController | undefined;

  constructor(private config: Config, runDir?: string) {
    super();
    this.llm = new LlmClient(config.llm);
    this.session = new Session(config.workspaceRoot, runDir);
    this.messages.push({ role: 'system', content: buildSystemPrompt(config) });
  }

  cancelActiveTask(): void {
    this.abortController?.abort();
  }

  /** Drop conversation history, keeping the session workspace. */
  resetConversation(): void {
    this.messages = [{ role: 'system', content: buildSystemPrompt(this.config) }];
  }

  async handleUserMessage(text: string): Promise<void> {
    this.messages.push({ role: 'user', content: text });
    const { maxTurns, maxDelegationsPerMessage } = this.config.orchestrator;
    let delegations = 0;
    let blockedRetries = 0;

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const action = await this.nextAction();
        if (!action) {
          this.emit('assistant_text', 'Sorry — I could not produce a valid next step.');
          break;
        }

        if (action.action === 'respond') {
          this.emit('assistant_text', action.message);
          break;
        }

        if (delegations >= maxDelegationsPerMessage) {
          this.emit(
            'assistant_text',
            `Reached the delegation limit (${maxDelegationsPerMessage}) for one message. Tell me how to continue.`,
          );
          break;
        }
        if (!this.config.agents[action.agent].enabled) {
          this.pushResult({ status: 'error', summary: `Agent "${action.agent}" is disabled.`, exitCode: undefined });
          continue;
        }

        delegations += 1;
        const result = await this.delegate(action);
        if (result.status === 'blocked_by_permissions') {
          blockedRetries += 1;
          if (blockedRetries > 1) {
            // Invariant: never widen scope in response to a denial. Report instead.
            this.emit(
              'assistant_text',
              `The task was blocked by permissions and stayed blocked after one rephrase: ${result.summary}. It would need broader approval than handsfree grants.`,
            );
            break;
          }
        }
        this.pushResult(result);
      }
    } catch (err) {
      this.emit('error', (err as Error).message);
    } finally {
      this.emit('turn_done');
    }
  }

  private async nextAction(): Promise<Action | null> {
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
      const reply = await this.llm.chat(prompt);
      const parsed = parseAction(reply);
      if (parsed.ok) {
        this.messages.push({ role: 'assistant', content: JSON.stringify(parsed.action) });
        return parsed.action;
      }
      lastError = parsed.error;
    }
    return null;
  }

  private async delegate(action: Extract<Action, { action: 'delegate' }>): Promise<DelegationResult> {
    const { agent, task, done_when } = action;
    const adapter = ADAPTERS[agent];
    const agentCfg = this.config.agents[agent];
    const taskPaths = this.session.createTask(agent, '');
    const brief = buildBrief(agent, task, done_when, taskPaths, this.session.relative(this.session.contextFile));
    const fs = await import('node:fs');
    fs.writeFileSync(taskPaths.briefFile, brief);

    const prompt = buildDelegatePrompt(taskPaths, this.session.runDir);
    const invocation = adapter.buildInvocation(prompt, taskPaths, this.session.runDir, this.config);

    this.emit('task_started', { id: taskPaths.id, agent, task });
    this.abortController = new AbortController();
    const run = await runCli(invocation, {
      cwd: this.session.runDir,
      timeoutMs: agentCfg.timeoutMs,
      signal: this.abortController.signal,
      onChunk: (chunk) => this.emit('task_output_chunk', { id: taskPaths.id, agent, chunk }),
    });
    this.abortController = undefined;

    this.session.writeRaw(taskPaths, run.output);
    const parsed = adapter.parseOutput(run.output, taskPaths);
    const status = classifyOutcome(run, parsed);
    const summaryFull = this.session.ensureResult(taskPaths, parsed.finalMessage);
    const summary = summaryFull.slice(0, this.config.orchestrator.maxResultChars);

    this.session.appendContext(
      `- Task ${taskPaths.id} (${agent}): ${status} — ${task.slice(0, 120)} — result: ${this.session.relative(taskPaths.resultFile)}`,
    );
    this.emit('task_finished', { id: taskPaths.id, agent, status, summary });
    return { status, summary: status === 'blocked_by_permissions' ? `${summary}\nDenied: ${parsed.denials.join('; ')}` : summary, exitCode: run.exitCode };
  }

  private pushResult(result: DelegationResult): void {
    this.messages.push({
      role: 'user',
      content: JSON.stringify({
        task_result: { status: result.status, summary: result.summary.slice(0, this.config.orchestrator.maxResultChars) },
      }),
    });
  }
}
