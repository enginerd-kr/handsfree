import { describe, expect, it } from 'vitest';
import { Transcript } from '../workspace/transcript.js';
import { buildView } from './view-model.js';

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
    expect(view[0]?.text).toBe('Write notes.txt [notes.txt]');
    expect(view[0]?.tone).toBe('muted');
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
    expect(view[0]?.text).toBe('refused: Edit /etc/hosts — outside the workspace');
    expect(view[0]?.tone).toBe('bad');
  });

  it('keeps adapter stderr out of the view', () => {
    const t = transcript();
    t.append({ type: 'agent_stderr', agentId: 'claude', text: 'DeprecationWarning: ...' });
    expect(buildView(t.all(), WORKSPACE)).toHaveLength(0);
  });
});
