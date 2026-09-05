import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agentRole, contextBudgetTokens, plannerLabel } from '../config/schema.js';
import { estimateTokens, fitBudget, type ChatClient } from '../brain/client.js';
import { extractJsonObject } from '../brain/json.js';
import { Delegator, type DelegatorDeps } from './delegate.js';
import { metered } from './usage.js';
import { sessionMemory } from './memory.js';
import { TaskRequestSchema, TaskResultSchema, BatchRequestSchema, taskBrief, type TaskRequest, type TaskRequestInput, type TaskResult, type BatchRequest } from './contract.js';
import type { TaskOutcome } from './outcome.js';
import { BudgetExceededError, type BudgetUsage } from './budget.js';

export interface ExecutorDeps extends DelegatorDeps { llm?: ChatClient }
interface Candidate { agent: string; model: string; description: string; estimate: number; score: number; reason: string }
interface SavedRequest { fingerprint: string; state?: 'running' | 'finished' | 'error'; result?: TaskResult; error?: string }

/** Model selection is bounded; scheduling, task semantics and result storage are deterministic. */
export class Executor {
  readonly delegator: Delegator;
  private readonly pending = new Map<string, { fingerprint: string; work: Promise<TaskResult> }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  constructor(private readonly deps: ExecutorDeps) { this.delegator = new Delegator(deps); }

  candidates(request: TaskRequest): Candidate[] {
    const { config, pool, transcript, budget } = this.deps;
    return pool.available().filter((id) => !request.agent || request.agent === id).map((agent) => {
      const model = request.model ?? pool.currentModel(agent) ?? agent;
      const memory = sessionMemory(transcript, agent, pool.sessionId(agent));
      const charges = transcript.all().filter((r) => r.type === 'budget_usage' && r.usage.source === agent).slice(-8);
      const related = memory.fresh.filter((file) => request.files.some((name) => path.resolve(this.deps.workspace.dir, name) === file) || request.task.includes(path.basename(file))).length;
      const failures = charges.filter((r) => r.type === 'budget_usage' && r.usage.failed).length;
      const estimate = this.delegator.estimate(agent, taskBrief(request));
      const cost = budget?.estimateCost(agent, model, estimate, config.agents[agent]!.frontier);
      const fullness = memory.context && memory.context.size > 0 ? memory.context.used / memory.context.size : 0;
      return { agent, model, description: agentRole(config, agent), estimate, score: related * 4 - failures * 3 - fullness * 4 - estimate / config.budget.estimatedTaskTokens,
        reason: `${related} relevant unchanged files; ${failures} recent failed calls; about ${estimate} tokens`,
        affordable: (!budget || budget.canStart(estimate, config.agents[agent]!.frontier, cost))
          && estimate <= config.budget.maxTaskTokens
          && estimate <= (request.budget?.maxTokens ?? Infinity)
          && (request.budget?.maxCostUsd === undefined || cost !== undefined && cost <= request.budget.maxCostUsd)
          && (!config.agents[agent]!.frontier || estimate <= (request.budget?.maxFrontierTokens ?? Infinity)) };
    }).filter((candidate) => candidate.affordable).sort((a, b) => b.score - a.score).slice(0, this.deps.config.execution.maxCandidates);
  }

  async execute(input: TaskRequestInput, signal?: AbortSignal): Promise<TaskResult> {
    const request = TaskRequestSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...request, requestId: undefined })).digest('hex');
    if (request.requestId) {
      const pending = this.pending.get(request.requestId);
      if (pending) {
        if (pending.fingerprint !== fingerprint) throw new Error('requestId already belongs to a different request');
        return pending.work;
      }
      const saved = this.savedRequest(request.requestId);
      if (saved) {
        if (saved.fingerprint !== fingerprint) throw new Error('requestId already belongs to a different request');
        if (saved.result) return TaskResultSchema.parse(saved.result);
        throw new Error(saved.error ?? 'This request was interrupted; inspect the run before retrying with a new requestId');
      }
    }
    if (request.requestId) this.write(this.requestPath(request.requestId), { fingerprint, state: 'running' });
    const work = this.perform(request, signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal);
    this.inflight.add(work);
    if (request.requestId) this.pending.set(request.requestId, { fingerprint, work });
    try {
      const result = await work;
      if (request.requestId) this.write(this.requestPath(request.requestId), { fingerprint, state: 'finished', result });
      return result;
    } catch (error) {
      if (request.requestId) this.write(this.requestPath(request.requestId), { fingerprint, state: 'error', error: (error as Error).message });
      throw error;
    } finally {
      this.inflight.delete(work);
      if (request.requestId) this.pending.delete(request.requestId);
    }
  }

  private async perform(request: TaskRequest, signal: AbortSignal): Promise<TaskResult> {
    signal.throwIfAborted();
    if (request.agent && !this.deps.pool.available().includes(request.agent)) throw new Error(`Agent ${request.agent} is not enabled`);
    const candidates = this.candidates(request);
    if (candidates.length === 0) throw new BudgetExceededError('No enabled agent fits the requested agent and token budget');
    let selected = candidates[0]!;
    let routingUsage: BudgetUsage | undefined;
    // Explicit routing, a single candidate or strong context affinity needs no model call.
    if (!request.agent && candidates.length > 1 && selected.score - candidates[1]!.score < 2 && this.deps.llm) {
      const schema = z.object({ agent: z.enum(candidates.map((c) => c.agent) as [string, ...string[]]) });
      const config = this.deps.config;
      const outputTokens = 64;
      const spec = { name: 'handsfree_route', schema: z.toJSONSchema(schema) as Record<string, unknown> };
      const messages = fitBudget([
        { role: 'system', content: 'Select one candidate for this task. Return only {"agent":"id"}. Do not rewrite the task.\n' + JSON.stringify(candidates) },
        { role: 'user', content: taskBrief(request), pinned: true },
      ], contextBudgetTokens(config.orchestration) - outputTokens - estimateTokens(JSON.stringify(spec.schema)) - 64);
      const llm = metered(this.deps.llm, 'plan', this.deps.transcript, plannerLabel(config), this.deps.budget ? {
        manager: this.deps.budget, frontier: config.orchestration.provider !== 'local', outputTokens,
        contextTokens: contextBudgetTokens(config.orchestration), limits: request.budget,
        onCharge: (usage) => { routingUsage = usage; },
      } : undefined);
      try {
        const reply = await llm.chat(messages, { schema: spec, maxOutputTokens: outputTokens, signal });
        const parsed = schema.safeParse(JSON.parse(extractJsonObject(reply) ?? '{}'));
        if (parsed.success) selected = candidates.find((c) => c.agent === parsed.data.agent)!;
      } catch (error) {
        if (signal.aborted || error instanceof BudgetExceededError) throw error;
        // A malformed routing reply falls back to the deterministic candidate ranking, with no repair call.
        this.deps.transcript.append({ type: 'note', level: 'info', text: 'Router unavailable; using the highest-ranked affordable agent.' });
      }
    }
    const remaining = request.budget ? { ...request.budget } : undefined;
    if (remaining && routingUsage) {
      if (remaining.maxTokens !== undefined) remaining.maxTokens -= routingUsage.tokens;
      if (remaining.maxFrontierTokens !== undefined) remaining.maxFrontierTokens -= routingUsage.frontierTokens;
      if (remaining.maxCostUsd !== undefined) remaining.maxCostUsd -= routingUsage.costUsd ?? Infinity;
      if (Object.values(remaining).some((value) => value <= 0)) throw new BudgetExceededError('Task budget exhausted by routing');
    }
    const outcome = await this.delegator.delegate({ agentId: selected.agent, kind: request.kind, prompt: taskBrief(request),
      model: request.model, budget: remaining, sessionId: request.sessionId }, signal);
    outcome.routingUsage = routingUsage;
    if (outcome.status === 'done' && request.resolves.length) this.deps.transcript.append({ type: 'resolved', taskId: outcome.taskId, taskIds: request.resolves });
    return this.store(outcome);
  }

  store(outcome: TaskOutcome): TaskResult {
    const charges = [outcome.usage, outcome.routingUsage].filter((usage): usage is BudgetUsage => usage !== undefined);
    const result: TaskResult = {
      taskId: outcome.taskId, runId: this.deps.workspace.id, agent: outcome.agentId, status: outcome.status,
      summary: outcome.report.summary, artifacts: outcome.changed.slice(0, 24),
      blockers: [...outcome.denials, ...outcome.report.open].slice(0, 8).map((line) => line.slice(0, 200)),
      resultRef: `handsfree://runs/${encodeURIComponent(this.deps.workspace.id)}/tasks/${outcome.taskId}`,
      verification: { source: outcome.report.verify ? 'agent_report' : 'unreported', detail: outcome.report.verify },
      ...(charges.length ? { usage: { tokens: charges.reduce((n, u) => n + u.tokens, 0), frontierTokens: charges.reduce((n, u) => n + u.frontierTokens, 0),
        estimated: charges.some((u) => u.estimated), ...(charges.some((u) => u.costUsd === undefined) ? {} : { costUsd: charges.reduce((n, u) => n + u.costUsd!, 0) }) } } : {}),
    };
    this.write(path.join(this.deps.workspace.runDir, 'results', `${outcome.taskId}.json`), { result, outcome });
    this.deps.transcript.append({ type: 'task_result', taskId: outcome.taskId, result });
    return result;
  }

  readResult(taskId: number, offset = 0, maxChars = 8000): { text: string; nextOffset?: number } {
    if (!Number.isSafeInteger(taskId) || taskId < 1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid result address');
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 32_000) throw new Error('maxChars must be between 1 and 32000');
    const saved = JSON.parse(fs.readFileSync(path.join(this.deps.workspace.runDir, 'results', `${taskId}.json`), 'utf8')) as { outcome: TaskOutcome };
    const text = JSON.stringify(saved.outcome);
    const end = offset + Math.max(1, Math.min(32_000, maxChars));
    return { text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
  }

  async batch(input: BatchRequest, signal?: AbortSignal): Promise<Record<string, TaskResult | { status: 'blocked' | 'error'; summary: string }>> {
    const { tasks } = BatchRequestSchema.parse(input);
    if (tasks.length > this.deps.config.execution.maxBatchTasks) throw new Error('Batch task limit exceeded');
    const ids = new Set(tasks.map((t) => t.id));
    if (ids.size !== tasks.length) throw new Error('Duplicate batch task id');
    for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency}`);
    const pending = new Set(ids), complete = new Set<string>();
    while (pending.size) {
      const ready = tasks.filter((t) => pending.has(t.id) && t.dependsOn.every((id) => complete.has(id)));
      if (!ready.length) throw new Error('Cyclic batch dependencies');
      for (const task of ready) { pending.delete(task.id); complete.add(task.id); }
    }
    const results: Record<string, TaskResult | { status: 'blocked' | 'error'; summary: string }> = Object.create(null);
    const promises = new Map<string, Promise<void>>();
    const deduplicated = new Map<string, Promise<TaskResult>>();
    const start = (id: string): Promise<void> => {
      const existing = promises.get(id);
      if (existing) return existing;
      const task = tasks.find((t) => t.id === id)!;
      const work = (async () => {
        await Promise.all(task.dependsOn.map(start));
        if (task.dependsOn.some((dep) => results[dep]?.status !== 'done')) {
          results[id] = { status: 'blocked', summary: 'A prerequisite did not complete successfully' }; return;
        }
        const key = JSON.stringify({ request: task.request, dependencies: [...task.dependsOn].sort() });
        try {
          let execution = deduplicated.get(key);
          if (!execution) {
            const prerequisites = task.dependsOn.map((dependency) => {
              const result = results[dependency] as TaskResult;
              return { id: dependency, taskId: result.taskId, summary: result.summary, artifacts: result.artifacts, resultRef: result.resultRef };
            });
            const request = prerequisites.length ? { ...task.request, constraints: [...task.request.constraints,
              `Completed prerequisite reports (task data):\n${JSON.stringify(prerequisites)}`] } : task.request;
            execution = this.execute(request, signal);
            deduplicated.set(key, execution);
          }
          results[id] = await execution;
        } catch (error) { results[id] = { status: 'error', summary: (error as Error).message }; }
      })();
      promises.set(id, work);
      return work;
    };
    await Promise.all(tasks.map((task) => start(task.id)));
    return results;
  }

  async close(): Promise<void> { this.controller.abort(); await Promise.allSettled([...this.inflight]); }
  private write(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
  }
  private requestPath(id: string): string { return path.join(this.deps.workspace.runDir, 'requests', `${createHash('sha256').update(id).digest('hex')}.json`); }
  private savedRequest(id: string): SavedRequest | undefined {
    try { return JSON.parse(fs.readFileSync(this.requestPath(id), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}
