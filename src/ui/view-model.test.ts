import { describe, expect, it } from 'vitest';
import { Transcript } from '../workspace/transcript.js';
import { buildView, describeRecord, ledgerEntries, sessionsOf, turnPhase, workingAgents } from './view-model.js';

const WORKSPACE = '/ws';

function transcript(): Transcript {
  return new Transcript();
}

describe('buildView', () => {
  it('joins streamed message chunks into one block', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'hi' });
    for (const text of ['Hel', 'lo ', 'there']) {
      t.append({
        type: 'session_update',
        agentId: 'claude',
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    }

    const view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(2);
    expect(view[1]?.text).toBe('Hello there');
  });

  it('keeps a thought apart from what the agent actually said', () => {
    const t = transcript();
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'weighing it' } },
    });
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
    });

    const view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(2);
    expect(view[0]).toMatchObject({ marker: 'thought', text: 'weighing it', tone: 'muted' });
    expect(view[1]).toMatchObject({ marker: 'bullet', text: 'Done.' });
  });

  it('updates a tool call in place rather than repeating it', () => {
    const t = transcript();
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Write notes.txt',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: '/ws/notes.txt' }],
      },
    });
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    });

    const view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(1);
    expect(view[0]?.text).toBe('Write notes.txt');
    expect(view[0]?.markerTone).toBe('good');
  });

  it('shows what a tool call produced, not just its title', () => {
    const t = transcript();
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Run tests',
        kind: 'execute',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '3 passed\n0 failed' } }],
      },
    });

    const view = buildView(t.all(), WORKSPACE);
    expect(view[0]?.lines.map((line) => line.text)).toEqual(['3 passed', '0 failed']);
  });

  it('turns a whole-file diff into the lines that changed', () => {
    const t = transcript();
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Edit',
        kind: 'edit',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: '/ws/notes.txt',
            oldText: 'one\ntwo\nthree',
            newText: 'one\nTWO\nthree',
          },
        ],
      },
    });

    const view = buildView(t.all(), WORKSPACE);
    expect(view[0]?.lines).toEqual([
      { text: 'Updated notes.txt (+1 −1)', tone: 'muted' },
      { text: '- two', tone: 'bad' },
      { text: '+ TWO', tone: 'good' },
    ]);
  });

  it('draws a plan as a checklist', () => {
    const t = transcript();
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'read the config', priority: 'high', status: 'completed' },
          { content: 'write the file', priority: 'high', status: 'in_progress' },
        ],
      },
    });

    const view = buildView(t.all(), WORKSPACE);
    expect(view[0]?.text).toBe('Plan (1/2)');
    expect(view[0]?.lines.map((line) => line.text)).toEqual([
      '☒ read the config',
      '☐ write the file',
    ]);
  });

  it('indents an agent under the task it was given, and closes it on stop', () => {
    const t = transcript();
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'say hi' });
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    });
    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });

    const view = buildView(t.all(), WORKSPACE, { expanded: true });
    expect(view.map((item) => item.depth)).toEqual([0, 1, 1]);
    expect(view[2]?.marker).toBe('result');
    expect(view[2]?.text).toMatch(/^Done/);
  });

  it('marks every row of a task with its id, and nothing outside it', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'hello' });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'say hi' });
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    });
    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });
    t.append({ type: 'assistant', text: 'claude said hi' });

    // The whole block answers to the task: a hover lights all of it, and a
    // click anywhere in it folds or unfolds it.
    const view = buildView(t.all(), WORKSPACE, { expanded: true });
    expect(view.map((item) => item.taskId)).toEqual([undefined, 1, 1, 1, undefined]);
  });

  it('watches a task while it runs and folds it once it ends', () => {
    const t = transcript();
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'say hi' });
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    });

    // Still running: everything the agent sends is on screen.
    expect(buildView(t.all(), WORKSPACE)).toHaveLength(2);

    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });

    const folded = buildView(t.all(), WORKSPACE, { expandHint: 'ctrl+o to expand' });
    expect(folded.map((item) => item.marker)).toEqual(['bullet', 'result']);
    expect(folded[1]?.text).toBe('Done (1s · ctrl+o to expand)');
  });

  // Asked for a file, an agent hands the file back. Whole, that is the screen.
  it('keeps a running task to the head of what it says, and counts the rest', () => {
    const t = transcript();
    const readme = Array.from({ length: 40 }, (_, line) => `line ${line + 1}`).join('\n');
    t.append({ type: 'delegation', taskId: 1, agentId: 'gemini', sessionId: 's', task: 'show it' });
    t.append({
      type: 'session_update',
      agentId: 'gemini',
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: readme } },
    });

    const view = buildView(t.all(), WORKSPACE, { expandHint: 'ctrl+o to expand' });
    expect(view[1]?.text.split('\n')).toHaveLength(12);
    expect(view[1]?.text.endsWith('line 12')).toBe(true);
    expect(view[1]?.lines.map((line) => line.text)).toEqual([
      '… +28 lines (ctrl+o to expand)',
    ]);

    // Unfolding the task is the way back to all of it.
    const open = buildView(t.all(), WORKSPACE, { expandedTasks: new Set([1]) });
    expect(open[1]?.text).toBe(readme);
    expect(open[1]?.lines).toEqual([]);
  });

  it('caps a tool call by its own output, keeping the approvals under it', () => {
    const t = transcript();
    t.append({ type: 'delegation', taskId: 1, agentId: 'gemini', sessionId: 's', task: 'read it' });
    t.append({
      type: 'session_update',
      agentId: 'gemini',
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Read README.md',
        kind: 'read',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: Array.from({ length: 20 }, (_, line) => `line ${line + 1}`).join('\n'),
            },
          },
        ],
      },
    });
    t.append({
      type: 'decision',
      agentId: 'gemini',
      entry: {
        at: 0,
        verdict: 'allow',
        rule: 'fs.read',
        summary: 'read README.md',
        request: { kind: 'fs.read', agentId: 'gemini', sessionId: 's', path: '/ws/README.md' },
      },
    });

    const view = buildView(t.all(), WORKSPACE, { expandHint: 'ctrl+o to expand' });
    const lines = view[1]?.lines.map((line) => line.text) ?? [];
    expect(lines).toHaveLength(14);
    expect(lines[11]).toBe('line 12');
    expect(lines[12]).toBe('… +8 lines (ctrl+o to expand)');
    expect(lines[13]).toBe('✓ read README.md');
  });

  // Handsfree's own answer is the answer; there is nothing to unfold it from.
  it('never caps handsfree\'s own reply', () => {
    const t = transcript();
    const long = Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join('\n');
    t.append({ type: 'assistant', text: long });

    const view = buildView(t.all(), WORKSPACE, { expandHint: 'ctrl+o to expand' });
    expect(view[0]?.text).toBe(long);
    expect(view[0]?.lines).toEqual([]);
  });

  it('draws nothing from before a clear, and leaves the note that follows it', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'remember this' });
    t.append({ type: 'assistant', text: 'remembered' });
    t.append({ type: 'user', text: '/clear' });
    t.append({ type: 'clear' });
    t.append({ type: 'note', level: 'info', text: 'context cleared' });

    const view = buildView(t.all(), WORKSPACE);
    expect(view.map((item) => item.text)).toEqual(['context cleared']);
  });

  // Clearing is a thing done to the screen, not to the work: a task in flight
  // keeps sending, and what it sends still belongs to it.
  it('keeps the rows of a running task its own across a clear', () => {
    const t = transcript();
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'say hi' });
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } },
    });
    t.append({ type: 'clear' });
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'and done' } },
    });
    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });

    const view = buildView(t.all(), WORKSPACE, { expanded: true });
    expect(view.map((item) => item.text)).toEqual(['and done', 'Done (1s)']);
    expect(view.map((item) => item.taskId)).toEqual([1, 1]);
    expect(view.map((item) => item.depth)).toEqual([1, 1]);

    // And the closing row still folds what is left of the task away.
    const folded = buildView(t.all(), WORKSPACE);
    expect(folded.map((item) => item.marker)).toEqual(['result']);
  });

  it('never folds a refusal away with the rest of the task', () => {
    const t = transcript();
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'do it' });
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'trying' } },
    });
    t.append({
      type: 'decision',
      agentId: 'claude',
      entry: {
        at: 0,
        verdict: 'deny',
        rule: 'exec.outside',
        reason: 'outside the workspace',
        summary: 'run rm -rf /etc',
        request: {
          kind: 'exec',
          agentId: 'claude',
          sessionId: 's',
          command: 'rm',
          args: ['-rf', '/etc'],
          cwd: '/ws',
        },
      },
    });
    t.append({ type: 'note', level: 'error', text: 'claude went away' });
    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });

    const view = buildView(t.all(), WORKSPACE);
    expect(view.map((item) => item.marker)).toEqual(['bullet', 'refused', 'none', 'result']);
    expect(view[2]?.tone).toBe('bad');
  });

  it('folds routine approvals under the call they approved', () => {
    const t = transcript();
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Write notes.txt',
        kind: 'edit',
        status: 'completed',
      },
    });
    t.append({
      type: 'decision',
      agentId: 'claude',
      entry: {
        at: 0,
        verdict: 'allow',
        rule: 'fs.write.inside',
        summary: 'write notes.txt (7 bytes)',
        request: {
          kind: 'fs.write',
          agentId: 'claude',
          sessionId: 's',
          path: '/ws/notes.txt',
          bytes: 7,
        },
      },
    });
    t.append({ type: 'note', level: 'info', text: 'wrote notes.txt' });

    const view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(1);
    expect(view[0]?.lines.map((line) => line.text)).toEqual([
      '✓ write notes.txt (7 bytes)',
      'wrote notes.txt',
    ]);
  });

  it('puts a note\u2019s own lines under it', () => {
    const t = transcript();
    t.append({ type: 'note', level: 'info', text: 'commands', lines: ['/help  what you can type'] });

    const view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ role: 'system', text: 'commands', gap: true });
    expect(view[0]?.lines.map((line) => line.text)).toEqual(['/help  what you can type']);
  });

  // Folding it into the call would keep the headline and drop everything the
  // note was actually written to say.
  it('never folds a note that brought its own lines', () => {
    const t = transcript();
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Write notes.txt',
        kind: 'edit',
        status: 'completed',
      },
    });
    t.append({ type: 'note', level: 'info', text: 'commands', lines: ['/help'] });

    const view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(2);
    expect(view[1]?.lines.map((line) => line.text)).toEqual(['/help']);
  });

  it('keeps a refusal on its own line, never folded away', () => {
    const t = transcript();
    t.append({
      type: 'session_update',
      agentId: 'claude',
      sessionId: 's',
      update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'failed' },
    });
    t.append({
      type: 'decision',
      agentId: 'claude',
      entry: {
        at: 0,
        verdict: 'deny',
        rule: 'exec.outside',
        reason: 'outside the workspace',
        summary: 'run rm -rf /etc',
        request: {
          kind: 'exec',
          agentId: 'claude',
          sessionId: 's',
          command: 'rm',
          args: ['-rf', '/etc'],
          cwd: '/ws',
        },
      },
    });

    const view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(2);
    expect(view[1]).toMatchObject({ marker: 'refused', tone: 'bad' });
  });

  it('shows refusals in full', () => {
    const t = transcript();
    t.append({
      type: 'decision',
      agentId: 'claude',
      entry: {
        at: 0,
        verdict: 'deny',
        rule: 'tool.outside',
        reason: 'outside the workspace',
        summary: 'Edit /etc/hosts',
        request: {
          kind: 'tool',
          agentId: 'claude',
          sessionId: 's',
          toolKind: 'edit',
          title: 'Edit /etc/hosts',
          locations: ['/etc/hosts'],
          rawInput: null,
        },
      },
    });

    const view = buildView(t.all(), WORKSPACE);
    expect(view[0]?.marker).toBe('refused');
    expect(view[0]?.text).toBe('Edit /etc/hosts — outside the workspace');
    expect(view[0]?.tone).toBe('bad');
  });

  it('joins handsfree its own streamed reply into one block, settled by the close', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'hi' });
    for (const text of ['Hel', 'lo ', 'there']) {
      t.append({ type: 'assistant_delta', stream: 1, text });
    }

    // Still streaming: the block reads as one row.
    let view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(2);
    expect(view[1]).toMatchObject({ role: 'handsfree', text: 'Hello there' });

    t.append({ type: 'assistant', stream: 1, text: 'Hello there!' });

    // The close settles the final text in place rather than adding a row.
    view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(2);
    expect(view[1]?.text).toBe('Hello there!');
  });

  it('removes a streamed block its retraction says was not an answer', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'hi' });
    t.append({ type: 'assistant_delta', stream: 1, text: 'half a thou' });
    t.append({ type: 'assistant', stream: 1, text: '' });

    const view = buildView(t.all(), WORKSPACE);
    expect(view).toHaveLength(1);
    expect(view[0]?.role).toBe('user');
  });

  it('keeps adapter stderr out of the view', () => {
    const t = transcript();
    t.append({ type: 'agent_stderr', agentId: 'claude', text: 'DeprecationWarning: ...' });
    expect(buildView(t.all(), WORKSPACE)).toHaveLength(0);
  });
});

describe('workingAgents', () => {
  it('holds an agent from its delegation to its stop', () => {
    const t = transcript();
    expect(workingAgents(t.all()).size).toBe(0);

    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'dig' });
    expect([...workingAgents(t.all())]).toEqual(['claude']);

    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });
    expect(workingAgents(t.all()).size).toBe(0);
  });

  it('keeps one agent working while another finishes', () => {
    const t = transcript();
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'dig' });
    t.append({ type: 'delegation', taskId: 2, agentId: 'gemini', sessionId: 's', task: 'sort' });
    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'cancelled' });
    expect([...workingAgents(t.all())]).toEqual(['gemini']);
  });
});

describe('turnPhase', () => {
  // A prompt with nothing delegated under it yet is the start of the work,
  // however long handsfree has been thinking about it.
  it('reads a turn with nothing delegated yet as the start', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'fix the header' });
    t.append({ type: 'assistant', text: 'On it.' });
    expect(turnPhase(t.all())).toBe('start');
  });

  it('reads an open task as the work itself', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'fix the header' });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'fix it' });
    expect(turnPhase(t.all())).toBe('work');
  });

  // The agent's own checklist is the only honest measure of how far in a
  // task is; two of three ticked off is what puts the end in sight.
  it('follows the agent\'s plan while a task runs', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'fix the header' });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'fix it' });
    const plan = (done: number) => ({
      type: 'session_update' as const,
      agentId: 'claude',
      sessionId: 's',
      update: {
        sessionUpdate: 'plan' as const,
        entries: ['read', 'edit', 'test'].map((content, index) => ({
          content,
          priority: 'medium' as const,
          status: index < done ? ('completed' as const) : ('pending' as const),
        })),
      },
    });
    t.append(plan(1));
    expect(turnPhase(t.all())).toBe('work');
    t.append(plan(2));
    expect(turnPhase(t.all())).toBe('nearly');
  });

  // Every task stopped leaves only handsfree's own write-up, which is as
  // near done as this can say while the turn is still running.
  it('reads every task stopped as nearly done', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'fix the header' });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'fix it' });
    t.append({ type: 'delegation', taskId: 2, agentId: 'codex', sessionId: 's2', task: 'test it' });
    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });
    expect(turnPhase(t.all())).toBe('work');
    t.append({ type: 'stop', taskId: 2, agentId: 'codex', sessionId: 's2', stopReason: 'end_turn' });
    expect(turnPhase(t.all())).toBe('nearly');
  });

  // The phase is about this turn: what the last one delegated and finished
  // has no bearing on a prompt that has only just landed.
  it('forgets the turn before the last prompt', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'fix the header' });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'fix it' });
    t.append({ type: 'stop', taskId: 1, agentId: 'claude', sessionId: 's', stopReason: 'end_turn' });
    t.append({ type: 'user', text: 'now the footer' });
    expect(turnPhase(t.all())).toBe('start');
  });
});

describe('a delegation row under the line that named its agent', () => {
  it('shows the routing alone when the task is the line as typed', () => {
    const t = transcript();
    t.append({ type: 'user', text: '@claude run the tests' });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'run the tests' });
    const view = buildView(t.all(), WORKSPACE);
    expect(view[1]).toMatchObject({ label: 'claude', text: '' });
  });

  it('shows the task when the planner wrote it', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'make the tests pass' });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'Fix the failing test in a.test.ts' });
    const view = buildView(t.all(), WORKSPACE);
    expect(view[1]).toMatchObject({ label: 'claude', text: 'Fix the failing test in a.test.ts' });
  });

  it('shows the task when a mention named a different agent than the one that ran it', () => {
    const t = transcript();
    t.append({ type: 'user', text: '@gemini run the tests' });
    t.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's', task: 'run the tests' });
    expect(buildView(t.all(), WORKSPACE)[1]?.text).toBe('run the tests');
  });
});

describe('a session record', () => {
  it('is no row of the conversation, and is what the header reads', () => {
    const t = transcript();
    t.append({ type: 'session', agentId: 'claude', sessionId: 'c1', how: 'resumed' });
    t.append({ type: 'session', agentId: 'gemini', sessionId: 'g1', how: 'new' });
    t.append({ type: 'user', text: 'hi' });
    expect(buildView(t.all(), WORKSPACE)).toHaveLength(1);
    expect(sessionsOf(t.all())).toEqual({ claude: 'resumed', gemini: 'new' });
  });

  it('is a line in run output only when the session was resumed', () => {
    const t = transcript();
    const resumed = t.append({ type: 'session', agentId: 'claude', sessionId: 'c1', how: 'resumed' });
    const fresh = t.append({ type: 'session', agentId: 'gemini', sessionId: 'g1', how: 'new' });
    expect(describeRecord(resumed, WORKSPACE)).toBe('  resumed claude session c1');
    expect(describeRecord(fresh, WORKSPACE)).toBeUndefined();
  });
});

describe('a ledger reply', () => {
  it('is shown as one row per task, in the agent\'s colour, with the agent as the label', () => {
    const t = transcript();
    t.append({ type: 'user', text: 'do two things' });
    t.append({
      type: 'assistant',
      ledger: true,
      text:
        'Task 1 (claude): done — after 7s\nsummary: Ran the tests; all 9 pass.\n\n' +
        'Task 2 (gemini): refused — after 1s — refused: git push\n\n' +
        'Stopped at the limit of 2 tasks per message.',
    });
    const view = buildView(t.all(), WORKSPACE);
    expect(view.slice(1).map((item) => [item.agentId, item.label, item.text.split('\n')[0]])).toEqual([
      ['claude', 'claude', 'task 1: done — after 7s'],
      ['gemini', 'gemini', 'task 2: refused — after 1s — refused: git push'],
      [undefined, undefined, 'Stopped at the limit of 2 tasks per message.'],
    ]);
    expect(view[1]?.text).toContain('summary: Ran the tests; all 9 pass.');
  });

  it('splits a ledger into its tasks', () => {
    expect(ledgerEntries('Task 3 (codex): error — after 0s\nsummary: You have hit your usage limit.')).toEqual([
      { taskId: '3', agentId: 'codex', text: 'task 3: error — after 0s\nsummary: You have hit your usage limit.' },
    ]);
  });
});
