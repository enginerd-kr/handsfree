import type { AgentJobInput, AgentJobRecord } from '../../contracts/agent-job.js';
import type { Transcript } from '../../workspace/transcript.js';
import type { ToolContext, ToolResult } from './tools/tool.js';

interface Job {
  record: AgentJobRecord;
  controller: AbortController;
  done: Promise<void>;
  result?: ToolResult;
  delivered: boolean;
  hidden?: boolean;
}

/** Background work still runs through Delegator's workspace/session scheduler. */
export class AgentJobs {
  private counter = 0;
  private readonly jobs = new Map<number, Job>();
  constructor(private readonly transcript: Transcript) {
    for (const record of transcript.all()) {
      if (record.type === 'clear') this.jobs.clear();
      if (record.type !== 'agent_job') continue;
      this.counter = Math.max(this.counter, record.job.jobId);
      if (record.job.status !== 'running' && !this.jobs.has(record.job.jobId)) continue;
      this.jobs.set(record.job.jobId, { record: record.job, controller: new AbortController(), done: Promise.resolve(), delivered: true });
    }
    for (const job of this.jobs.values()) {
      if (job.record.status !== 'running') continue;
      job.record = { ...job.record, status: 'interrupted', text: 'The process ended before this job settled. Inspect saved task results before deciding whether to retry.' };
      this.record(job);
    }
  }

  start(input: AgentJobInput, ctx: ToolContext, run: (signal: AbortSignal) => Promise<ToolResult>): number {
    ctx.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ctx.signal]);
    const job: Job = { record: { jobId: ++this.counter, input, status: 'running', text: '', taskIds: [] },
      controller, done: Promise.resolve(), delivered: false };
    this.jobs.set(job.record.jobId, job);
    this.record(job);
    job.done = Promise.resolve().then(() => run(signal)).then((result) => {
      job.result = result;
      const outcomes = [...(result.outcomes ?? []), ...(result.outcome ? [result.outcome] : [])];
      job.record = { ...job.record, status: signal.aborted ? 'cancelled' : 'done', text: result.text,
        taskIds: outcomes.map((outcome) => outcome.taskId) };
    }, (error: unknown) => {
      job.record = { ...job.record, status: signal.aborted ? 'cancelled' : 'error', text: (error as Error).message };
    }).finally(() => this.record(job));
    return job.record.jobId;
  }

  get(jobId: number): AgentJobRecord {
    const job = this.jobs.get(jobId);
    if (!job || job.hidden) throw new Error(`No agent job ${jobId} in this conversation.`);
    return job.record;
  }
  list(): AgentJobRecord[] { return [...this.jobs.values()].filter((job) => !job.hidden).map((job) => job.record); }
  get running(): boolean { return this.list().some((job) => job.status === 'running'); }
  get pending(): boolean { return [...this.jobs.values()].some((job) => !job.delivered && job.record.status !== 'running'); }

  result(jobId: number): ToolResult {
    const record = this.get(jobId);
    const job = this.jobs.get(jobId)!;
    if (record.status !== 'running') job.delivered = true;
    return { ...job.result, halt: false, text: `Job ${jobId}: ${record.status}\n${record.text}` };
  }

  notifications(): ToolResult[] {
    return [...this.jobs.values()].filter((job) => !job.delivered && job.record.status !== 'running')
      .map((job) => this.result(job.record.jobId));
  }

  async wait(ids: number[], ctx: ToolContext): Promise<void> {
    const selected = ids.length ? ids.map((id) => { this.get(id); return this.jobs.get(id)!; })
      : [...this.jobs.values()].filter((job) => !job.hidden && job.record.status === 'running');
    const signal = ctx.wakeSignal ? AbortSignal.any([ctx.signal, ctx.wakeSignal]) : ctx.signal;
    if (signal.aborted) return;
    let wake!: () => void;
    const interrupted = new Promise<void>((resolve) => { wake = resolve; signal.addEventListener('abort', wake, { once: true }); });
    try { await Promise.race([Promise.all(selected.map((job) => job.done)), interrupted]); }
    finally { signal.removeEventListener('abort', wake); }
  }

  cancel(id: number): void { this.get(id); this.jobs.get(id)!.controller.abort(); }
  reset(): void {
    for (const job of this.jobs.values()) { job.hidden = true; job.delivered = true; job.controller.abort(); }
  }
  async close(): Promise<void> {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }
  private record(job: Job): void { this.transcript.append({ type: 'agent_job', job: job.record }); }
}
