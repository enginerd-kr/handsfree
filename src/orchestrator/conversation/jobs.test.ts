import { describe, expect, it } from 'vitest';
import { Transcript } from '../../workspace/transcript.js';
import { AgentJobs } from './jobs.js';

const input = { agent: 'a', kind: 'answer' as const, prompt: 'Analyze' };
const ctx = () => ({ signal: new AbortController().signal });

describe('agent job lifecycle', () => {
  it('cancels one job and leaves independent jobs running', async () => {
    const jobs = new AgentJobs(new Transcript());
    const first = jobs.start(input, ctx(), (signal) => new Promise((resolve) => {
      const done = () => resolve({ text: 'partial evidence', halt: true });
      if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true });
    }));
    const second = jobs.start(input, ctx(), async () => ({ text: 'independent evidence' }));
    jobs.cancel(first);
    await jobs.wait([], ctx());
    expect(jobs.get(first).status).toBe('cancelled');
    expect(jobs.result(first)).toMatchObject({ halt: false, text: 'job:1: cancelled\npartial evidence' });
    expect(jobs.get(second).status).toBe('done');
    expect(jobs.notifications()).toHaveLength(1);
    expect(jobs.notifications()).toEqual([]);
  });

  it('replays finished replies and marks interrupted work without rerunning it', async () => {
    const transcript = new Transcript();
    const jobs = new AgentJobs(transcript);
    const id = jobs.start(input, ctx(), async () => ({ text: 'full result' }));
    await jobs.wait([id], ctx());
    transcript.append({ type: 'agent_job', job: { jobId: 2, input, status: 'running', text: '', taskIds: [] } });
    const resumed = new AgentJobs(transcript);
    expect(resumed.get(1)).toMatchObject({ status: 'done', text: 'full result' });
    expect(resumed.get(2).status).toBe('interrupted');
    expect(resumed.running).toBe(false);
  });

  it('keeps old job results behind the clear boundary, including late results after restart', async () => {
    const transcript = new Transcript();
    const jobs = new AgentJobs(transcript);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const id = jobs.start(input, ctx(), async () => { await held; return { text: 'old result' }; });
    jobs.reset();
    transcript.append({ type: 'clear' });
    release();
    await jobs.close();
    expect(() => jobs.get(id)).toThrow('No agent job');
    expect(jobs.notifications()).toEqual([]);
    const resumed = new AgentJobs(transcript);
    expect(resumed.list()).toEqual([]);
    expect(resumed.start(input, ctx(), async () => ({ text: 'new' }))).toBeGreaterThan(id);
    await resumed.close();
  });

  it('preserves failed execution receipts across restart and repeated observations', async () => {
    const transcript = new Transcript();
    const jobs = new AgentJobs(transcript);
    const receipt = { status: 'error' as const, executed: false, created_tasks: [],
      error: { code: 'invalid_task_reference', message: 'Source unavailable. No agent was called.', valid_refs: ['task:1'] } };
    const id = jobs.start(input, ctx(), async () => ({ text: receipt.error.message, receipt }));
    await jobs.wait([id], ctx());
    const resumed = new AgentJobs(transcript);
    for (const registry of [jobs, resumed, resumed]) {
      expect(registry.result(id).receipt).toEqual({ ...receipt, executed: true,
        created_tasks: [], observed_tasks: [], job: 'job:1' });
    }
  });
});
