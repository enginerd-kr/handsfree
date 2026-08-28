import { describe, expect, it } from 'vitest';
import { Transcript } from '../workspace/transcript.js';
import { buildView, workingAgents } from './view-model.js';

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
