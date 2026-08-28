import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { changedFiles, touchedFiles, Transcript } from './transcript.js';

function updates(...list: SessionUpdate[]): Transcript {
  const transcript = new Transcript();
  for (const update of list) {
    transcript.append({ type: 'session_update', agentId: 'claude', sessionId: 's', update });
  }
  return transcript;
}

describe('changedFiles', () => {
  it('assembles one tool call from every record that carries its id', () => {
    // The usual shape: the opening call names the kind, and the update that
    // follows names the paths. Every field of an update but the id is
    // optional, so neither record says both.
    const transcript = updates(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', locations: [{ path: '/ws/a.ts' }] },
    );

    expect(changedFiles(transcript.all())).toEqual(['/ws/a.ts']);
  });

  it('leaves out an edit that failed', () => {
    const transcript = updates(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', locations: [{ path: '/ws/a.ts' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' },
    );

    // An edit that did not happen is not a file the next agent has to re-read.
    expect(changedFiles(transcript.all())).toEqual([]);
    // It was still reached for, which is what `touchedFiles` reports.
    expect(touchedFiles(transcript.all())).toEqual(['/ws/a.ts']);
  });

  it('keeps reads out of it and writes handsfree performed in it', () => {
    const transcript = updates({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read b.ts',
      kind: 'read',
      status: 'completed',
      locations: [{ path: '/ws/b.ts' }],
    });
    transcript.append({
      type: 'decision',
      agentId: 'claude',
      entry: {
        verdict: 'allow',
        rule: 'fs.write',
        at: Date.now(),
        summary: 'write /ws/c.ts',
        request: { kind: 'fs.write', path: '/ws/c.ts', bytes: 3, agentId: 'claude', sessionId: 's' },
      },
    });

    expect(changedFiles(transcript.all())).toEqual(['/ws/c.ts']);
  });

  it('counts a delete and a move, which change a file as surely as an edit', () => {
    const transcript = updates(
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'rm', kind: 'delete', status: 'completed', locations: [{ path: '/ws/old.ts' }] },
      { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'mv', kind: 'move', status: 'completed', locations: [{ path: '/ws/new.ts' }] },
    );

    expect(changedFiles(transcript.all())).toEqual(['/ws/old.ts', '/ws/new.ts']);
  });
});
