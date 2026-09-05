import { describe, expect, it } from 'vitest';
import { Transcript } from '../../workspace/transcript.js';
import {
  agentRecords,
  floorOf,
  renderAgentRecord,
  renderRunState,
  tasksSince,
} from './ledger.js';

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
    sessionId?: string;
  },
): void {
  const sessionId = options.sessionId ?? `s-${options.agentId}`;
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

  it('leaves out a task the clear landed in the middle of', () => {
    // `/clear` does not queue behind a turn, so this is a real sequence: the
    // task was handed out before the slate was wiped and finished after.
    const transcript = new Transcript();
    transcript.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'straddles' });
    transcript.append({ type: 'clear' });
    transcript.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });
    task(transcript, { taskId: 2, agentId: 'claude', task: 'after' });

    const floor = floorOf(transcript.all());
    // A clean slate with one stranger standing on it is not a clean slate.
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

  it('retains all tasks in run state', () => {
    const transcript = new Transcript();
    for (let id = 1; id <= 30; id++) {
      task(transcript, { taskId: id, agentId: 'claude', task: `task ${id}` });
    }

    const state = renderRunState(tasksSince(transcript.all(), 0), '/ws');
    expect(state).not.toContain('earlier tasks not listed');
    expect(state).toContain('task: task 1\n');
    expect(state).toContain('task: task 30');
  });
});

describe('agentRecords', () => {
  it('says what each agent has done and what its session is holding', () => {
    const transcript = new Transcript();
    task(transcript, { taskId: 1, agentId: 'claude', task: 'a', edited: ['/ws/a.ts'], read: ['/ws/b.ts'] });
    task(transcript, { taskId: 2, agentId: 'claude', task: 'b', edited: ['/ws/a.ts'] });
    task(transcript, { taskId: 3, agentId: 'gemini', task: 'c', stopReason: 'refusal' });

    const records = agentRecords(tasksSince(transcript.all(), 0));
    expect(records.get('claude')).toEqual({
      tasks: 2,
      // Read as well as changed: what its session holds is what it has seen.
      files: ['/ws/a.ts', '/ws/b.ts'],
      trouble: false,
    });
    expect(records.get('gemini')?.trouble).toBe(true);
  });

  it('renders a record the planner can pick an agent from', () => {
    const transcript = new Transcript();
    task(transcript, { taskId: 1, agentId: 'claude', task: 'a', edited: ['/ws/a.ts'], read: ['/ws/b.ts'] });

    const record = agentRecords(tasksSince(transcript.all(), 0)).get('claude');
    expect(renderAgentRecord(record, '/ws')).toBe('1 task this run; previously saw a.ts, b.ts');
  });

  it('forgets what an earlier session read, which the one on now never saw', () => {
    const transcript = new Transcript();
    task(transcript, { taskId: 1, agentId: 'claude', task: 'a', edited: ['/ws/old.ts'], sessionId: 'gone' });
    task(transcript, { taskId: 2, agentId: 'claude', task: 'b', edited: ['/ws/new.ts'], sessionId: 'live' });

    const record = agentRecords(tasksSince(transcript.all(), 0)).get('claude');
    // Both tasks count; only the live session's files are claimed to be open.
    expect(record?.tasks).toBe(2);
    expect(record?.files).toEqual(['/ws/new.ts']);
  });

  it('says nothing about an agent that has not worked yet', () => {
    expect(renderAgentRecord(undefined, '/ws')).toBe('');
  });

  it('names every file', () => {
    const transcript = new Transcript();
    task(transcript, {
      taskId: 1,
      agentId: 'claude',
      task: 'a',
      edited: ['/ws/1.ts', '/ws/2.ts', '/ws/3.ts', '/ws/4.ts', '/ws/5.ts', '/ws/6.ts', '/ws/7.ts', '/ws/8.ts'],
    });

    const record = agentRecords(tasksSince(transcript.all(), 0)).get('claude');
    expect(renderAgentRecord(record, '/ws')).toContain('7.ts, 8.ts');
  });
});

describe('renderRunState with reports', () => {
  it('spells out every task', () => {
    const transcript = new Transcript();
    for (let n = 1; n <= 5; n++) task(transcript, { taskId: n, agentId: 'gemini', task: `t${n}` });
    const state = renderRunState(tasksSince(transcript.all(), 0), '/ws');
    expect(state).not.toContain('earlier tasks not listed');
    expect(state).toContain('Task 4 (gemini)');
    expect(state).toContain('Task 5 (gemini)');
    expect(state).toContain('Task 3 (gemini)');
  });

  it('notes where the agent\'s own word on a finished turn is not "done"', () => {
    const transcript = new Transcript();
    task(transcript, { taskId: 1, agentId: 'gemini', task: 'x', said: 'REPORT\noutcome: blocked\nsummary: Needs a token.' });
    const state = renderRunState(tasksSince(transcript.all(), 0), '/ws');
    expect(state).toContain('Task 1 (gemini): blocked');
    expect(state).toContain('agent says: blocked');
  });

  it("carries what each agent said, so the planner keeps it once the turn has folded", () => {
    const transcript = new Transcript();
    task(transcript, {
      taskId: 1,
      agentId: 'gemini',
      task: 'TS와 JS의 차이점을 설명해 줘',
      said:
        'A long answer, at length, that the user has already read.\n\n' +
        'REPORT\noutcome: done\nsummary: TS는 정적 타입을 더한 JS의 상위 집합.\n  컴파일 단계에서 타입 오류를 잡는다.',
    });
    task(transcript, { taskId: 2, agentId: 'gemini', task: 'nothing to say', said: '' });
    const state = renderRunState(tasksSince(transcript.all(), 0), '/ws');
    expect(state).toContain('  task: TS와 JS의 차이점을 설명해 줘\n  said: TS는 정적 타입을 더한 JS의 상위 집합. 컴파일 단계에서 타입 오류를 잡는다.');
    expect(state).not.toContain('at length');
    // A task that said nothing gets no empty line for it.
    expect(state.endsWith('  task: nothing to say')).toBe(true);
  });
});
