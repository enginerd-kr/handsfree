import { describe, expect, it } from 'vitest';
import { Transcript } from '../workspace/transcript.js';
import { floorOf, renderHandoff, renderRunState, tasksSince } from './ledger.js';

/** A finished task, written into the record the way a real one is. */
function task(
  transcript: Transcript,
  options: {
    taskId: number;
    agentId: string;
    task: string;
    said?: string;
    edited?: string[];
    read?: string[];
    stopReason?: 'end_turn' | 'refusal' | 'max_tokens';
  },
): void {
  const sessionId = `s-${options.agentId}`;
  transcript.append({
    type: 'delegation',
    taskId: options.taskId,
    agentId: options.agentId,
    sessionId,
    task: options.task,
  });
  for (const path of options.edited ?? []) {
    transcript.append({
      type: 'session_update',
      agentId: options.agentId,
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `edit-${path}`,
        title: `Write ${path}`,
        kind: 'edit',
        status: 'completed',
        locations: [{ path }],
      },
    });
  }
  for (const path of options.read ?? []) {
    transcript.append({
      type: 'session_update',
      agentId: options.agentId,
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `read-${path}`,
        title: `Read ${path}`,
        kind: 'read',
        status: 'completed',
        locations: [{ path }],
      },
    });
  }
  if (options.said) {
    transcript.append({
      type: 'session_update',
      agentId: options.agentId,
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: options.said } },
    });
  }
  transcript.append({
    type: 'stop',
    taskId: options.taskId,
    agentId: options.agentId,
    sessionId,
    stopReason: options.stopReason ?? 'end_turn',
  });
}

describe('tasksSince', () => {
  it('rebuilds a finished task from the record alone', () => {
    const transcript = new Transcript();
    task(transcript, {
      taskId: 1,
      agentId: 'claude',
      task: 'Add parse()',
      said: 'Added parse().',
      edited: ['/ws/a.ts'],
      read: ['/ws/b.ts'],
    });

    const [rebuilt] = tasksSince(transcript.all(), 0);
    expect(rebuilt?.outcome).toMatchObject({
      taskId: 1,
      agentId: 'claude',
      task: 'Add parse()',
      status: 'done',
      message: 'Added parse().',
      changed: ['/ws/a.ts'],
    });
    // A file that was only read is not one the next agent has to re-read.
    expect(rebuilt?.outcome.changed).not.toContain('/ws/b.ts');
    expect(rebuilt?.outcome.files).toContain('/ws/b.ts');
  });

  it('counts a write handsfree performed as a change, whatever the agent called it', () => {
    const transcript = new Transcript();
    transcript.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'x' });
    transcript.append({
      type: 'decision',
      agentId: 'claude',
      entry: {
        verdict: 'allow',
        rule: 'fs.write',
        at: Date.now(),
        summary: 'write /ws/a.ts',
        request: { kind: 'fs.write', path: '/ws/a.ts', bytes: 4, agentId: 'claude', sessionId: 's' },
      },
    });
    transcript.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });

    expect(tasksSince(transcript.all(), 0)[0]?.outcome.changed).toEqual(['/ws/a.ts']);
  });

  it('reports only what finished after the mark', () => {
    const transcript = new Transcript();
    task(transcript, { taskId: 1, agentId: 'claude', task: 'one' });
    const mark = transcript.all().at(-1)!.seq;
    task(transcript, { taskId: 2, agentId: 'gemini', task: 'two' });

    expect(tasksSince(transcript.all(), mark).map((entry) => entry.outcome.taskId)).toEqual([2]);
  });

  it('leaves out a task still running', () => {
    const transcript = new Transcript();
    task(transcript, { taskId: 1, agentId: 'claude', task: 'one' });
    transcript.append({ type: 'delegation', taskId: 2, agentId: 'gemini', sessionId: 's', task: 'two' });

    expect(tasksSince(transcript.all(), 0)).toHaveLength(1);
  });
});

describe('floorOf', () => {
  it('draws the line at the last clear, so a cleared run plans from nothing', () => {
    const transcript = new Transcript();
    task(transcript, { taskId: 1, agentId: 'claude', task: 'before' });
    transcript.append({ type: 'clear' });
    task(transcript, { taskId: 2, agentId: 'claude', task: 'after' });

    const floor = floorOf(transcript.all());
    expect(tasksSince(transcript.all(), floor).map((entry) => entry.outcome.task)).toEqual(['after']);
  });
});

describe('renderRunState', () => {
  it('gives the planner a line per task and the files that are different', () => {
    const transcript = new Transcript();
    task(transcript, { taskId: 1, agentId: 'claude', task: 'Add parse()', edited: ['/ws/a.ts'] });
    task(transcript, { taskId: 2, agentId: 'gemini', task: 'Test parse()', edited: ['/ws/a.test.ts'] });

    const state = renderRunState(tasksSince(transcript.all(), 0), '/ws');
    expect(state).toContain('Task 1 (claude): done');
    expect(state).toContain('task: Add parse()');
    expect(state).toContain('Files changed this run: a.ts, a.test.ts');
  });

  it('is empty before anything has been delegated', () => {
    expect(renderRunState([], '/ws')).toBe('');
  });

  it('counts the tasks it stops listing rather than growing without bound', () => {
    const transcript = new Transcript();
    for (let id = 1; id <= 30; id++) {
      task(transcript, { taskId: id, agentId: 'claude', task: `task ${id}` });
    }

    const state = renderRunState(tasksSince(transcript.all(), 0), '/ws');
    expect(state).toContain('…6 earlier tasks not listed (6 by claude)');
    expect(state).not.toContain('task: task 1\n');
    expect(state).toContain('task: task 30');
  });
});

describe('renderHandoff', () => {
  const transcript = new Transcript();
  task(transcript, {
    taskId: 1,
    agentId: 'claude',
    task: 'Add parse()',
    said: 'Added parse(); empty input returns null.',
    edited: ['/ws/a.ts'],
  });
  task(transcript, {
    taskId: 2,
    agentId: 'gemini',
    task: 'Test parse()',
    said: 'Three tests; the blank case fails.',
    edited: ['/ws/a.test.ts'],
  });
  const tasks = tasksSince(transcript.all(), 0);

  it('tells an agent what the others changed, in their own words', () => {
    const handoff = renderHandoff({ tasks, agentId: 'claude', includeOwn: false, workspaceDir: '/ws' });
    expect(handoff).toContain('Since your last task:');
    expect(handoff).toContain('gemini (task 2) changed a.test.ts');
    expect(handoff).toContain('Three tests; the blank case fails.');
  });

  it("leaves out the agent's own work, which its session already remembers", () => {
    const handoff = renderHandoff({ tasks, agentId: 'claude', includeOwn: false, workspaceDir: '/ws' });
    expect(handoff).not.toContain('claude (task 1)');
    expect(handoff).not.toContain('empty input returns null');
  });

  it('includes its own work when the session is new and remembers nothing', () => {
    const handoff = renderHandoff({ tasks, agentId: 'claude', includeOwn: true, workspaceDir: '/ws' });
    expect(handoff).toContain('claude (task 1) changed a.ts');
  });

  it('says nothing at all when nothing has happened since', () => {
    expect(renderHandoff({ tasks: [], agentId: 'claude', includeOwn: false, workspaceDir: '/ws' })).toBe('');
  });

  it('passes on paths and an account, never file contents', () => {
    const handoff = renderHandoff({ tasks, agentId: 'claude', includeOwn: false, workspaceDir: '/ws' });
    // Short enough that a brief can carry it every task without crowding one out.
    expect(handoff.length).toBeLessThan(400);
  });

  it('reports a task that failed as well as one that changed files', () => {
    const failed = new Transcript();
    task(failed, { taskId: 1, agentId: 'gemini', task: 'x', said: 'I was refused.', stopReason: 'refusal' });

    const handoff = renderHandoff({
      tasks: tasksSince(failed.all(), 0),
      agentId: 'claude',
      includeOwn: false,
      workspaceDir: '/ws',
    });
    expect(handoff).toContain('changed nothing — refused');
  });
});
