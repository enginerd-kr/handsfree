import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { agentRole, plannerLabel } from '../../config/schema.js';
import { type ChatClient } from '../../models/client.js';
import { routingRequest } from './router.js';
import { Delegator, type DelegatorDeps } from './delegate.js';
import { metered } from '../usage/usage.js';
import { sessionMemory } from '../context/memory.js';
import { TaskRequestSchema, TaskResultSchema, BatchRequestSchema, taskBrief, type TaskRequest, type TaskRequestInput, type TaskResult, type BatchRequest } from '../../contracts/task.js';
import type { TaskOutcome } from '../results/outcome.js';
import type { TokenUsage } from '../../contracts/usage.js';

export interface ExecutorDeps extends DelegatorDeps { llm?: ChatClient }
interface Candidate { agent: string; model: string; description: string; estimate: number; score: number; reason: string }
interface SavedRequest { fingerprint: string; state?: 'running' | 'finished' | 'error'; result?: TaskResult; error?: string }

/** Scheduling, task semantics and result storage are deterministic. */
export class Executor {
  readonly delegator: Delegator;
  private readonly pending = new Map<string, { fingerprint: string; work: Promise<TaskResult> }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  constructor(private readonly deps: ExecutorDeps) { this.delegator = new Delegator(deps); }

  candidates(request: TaskRequest): Candidate[] {
    const { config, pool, transcript } = this.deps;
    return pool.available().filter((id) => (!request.agent || request.agent === id) && !pool.executionProblem(id)).map((agent) => {
      const model = request.model ?? pool.currentModel(agent) ?? agent;
      const memory = sessionMemory(transcript, agent, pool.sessionId(agent));
      const charges = transcript.all().filter((r) => r.type === 'budget_usage' && r.usage.source === agent).slice(-8);
      const related = memory.fresh.filter((file) => request.files.some((name) => path.resolve(this.deps.workspace.dir, name) === file) || request.task.includes(path.basename(file))).length;
      const failures = charges.filter((r) => r.type === 'budget_usage' && r.usage.failed).length;
      const estimate = this.delegator.estimate(agent, taskBrief(request));
      const fullness = memory.context && memory.context.size > 0 ? memory.context.used / memory.context.size : 0;
      return { agent, model, description: agentRole(config, agent), estimate, score: related * 4 - failures * 3 - fullness * 4,
        reason: `${related} relevant unchanged files; ${failures} recent failed calls; about ${estimate} tokens`,
      };
    }).sort((a, b) => b.score - a.score);
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
    if (request.agent) {
      const problem = this.deps.pool.executionProblem(request.agent);
      if (problem) throw new Error(problem);
    }
    const candidates = this.candidates(request);
    if (candidates.length === 0) {
      const enabled = this.deps.pool.available();
      if (enabled.length && enabled.every((id) => this.deps.pool.executionProblem(id))) throw new Error('All enabled agents are blocked by native-tool mediation requirements');
      throw new Error('No enabled agent matches the request');
    }
    let selected = candidates[0]!;
    let routingUsage: TokenUsage | undefined;
    // Explicit routing, a single candidate or strong context affinity needs no model call.
    const routing = this.deps.config.execution.routing;
    const consult = routing === 'model' || routing === 'auto' && this.deps.config.orchestration.provider !== 'acp';
    if (consult && !request.agent && candidates.length > 1 && selected.score - candidates[1]!.score < 2 && this.deps.llm) {
      const config = this.deps.config;
      const llm = metered(this.deps.llm, 'plan', this.deps.transcript, plannerLabel(config), this.deps.usage ? {
        manager: this.deps.usage, frontier: config.orchestration.provider !== 'local',
        onCharge: (usage) => { routingUsage = usage; },
      } : undefined);
      try {
        const route = routingRequest(candidates, taskBrief(request));
        const reply = await llm.chat(route.messages, { schema: route.schema, signal });
        const agent = route.parse(reply);
        if (agent) selected = candidates.find((c) => c.agent === agent)!;
      } catch (error) {
        if (signal.aborted) throw error;
        // A malformed routing reply falls back to the deterministic candidate ranking, with no repair call.
        this.deps.transcript.append({ type: 'note', level: 'info', text: 'Router unavailable; using the highest-ranked agent.' });
      }
    }
    const outcome = await this.delegator.delegate({ agentId: selected.agent, kind: request.kind, prompt: taskBrief(request),
      model: request.model, sessionId: request.sessionId }, signal);
    outcome.routingUsage = routingUsage;
    if (outcome.status === 'done' && request.resolves.length) this.deps.transcript.append({ type: 'resolved', taskId: outcome.taskId, taskIds: request.resolves });
    return this.store(outcome);
  }

  store(outcome: TaskOutcome): TaskResult {
    const charges = [outcome.usage, outcome.routingUsage].filter((usage): usage is TokenUsage => usage !== undefined);
    const result: TaskResult = {
      taskId: outcome.taskId, runId: this.deps.workspace.id, agent: outcome.agentId, status: outcome.status,
      summary: outcome.report.summary, artifacts: outcome.changed,
      blockers: [...outcome.denials, ...outcome.report.open],
      resultRef: `handsfree://runs/${encodeURIComponent(this.deps.workspace.id)}/tasks/${outcome.taskId}`,
      verification: { source: outcome.report.verify ? 'agent_report' : 'unreported', detail: outcome.report.verify },
      ...(charges.length ? { usage: { tokens: charges.reduce((n, u) => n + u.tokens, 0), frontierTokens: charges.reduce((n, u) => n + u.frontierTokens, 0),
        estimated: charges.some((u) => u.estimated), ...(charges.some((u) => u.costUsd === undefined) ? {} : { costUsd: charges.reduce((n, u) => n + u.costUsd!, 0) }) } } : {}),
    };
    this.write(path.join(this.deps.workspace.runDir, 'results', `${outcome.taskId}.json`), { result, outcome });
    this.deps.transcript.append({ type: 'task_result', taskId: outcome.taskId, result });
    return result;
  }

  readResult(taskId: number, offset = 0, maxChars?: number): { text: string; nextOffset?: number } {
    if (!Number.isSafeInteger(taskId) || taskId < 1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid result address');
    if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || maxChars < 1)) throw new Error('maxChars must be a positive integer');
    const saved = JSON.parse(fs.readFileSync(path.join(this.deps.workspace.runDir, 'results', `${taskId}.json`), 'utf8')) as { outcome: TaskOutcome };
    // Put evidence before the potentially long worker brief, so the first
    // page answers common follow-ups while later pages retain the full record.
    const { taskId: id, agentId, status, message, report, ...rest } = saved.outcome;
    const text = JSON.stringify({ taskId: id, agentId, status, message, report, ...rest });
    const end = maxChars === undefined ? text.length : offset + maxChars;
    return { text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
  }

  async batch(input: BatchRequest, signal?: AbortSignal): Promise<Record<string, TaskResult | { status: 'blocked' | 'error'; summary: string }>> {
    const { tasks } = BatchRequestSchema.parse(input);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (byId.size !== tasks.length) throw new Error('Duplicate batch task id');
    for (const task of tasks) for (const dependency of task.dependsOn) if (!byId.has(dependency)) throw new Error(`Unknown dependency ${dependency}`);
    const pending = new Set(byId.keys()), complete = new Set<string>();
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
      const task = byId.get(id)!;
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
