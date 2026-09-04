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

describe('Transcript replay', () => {
  it('reads a run back off its file and carries the sequence on', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-transcript-'));
    const file = path.join(dir, 'transcript.jsonl');

    const first = new Transcript(file);
    first.append({ type: 'user', text: 'one' });
    first.append({ type: 'delegation', taskId: 1, agentId: 'claude', sessionId: 's1', task: 'do it' });
    await first.close();
    // A line the dying process never finished.
    fs.appendFileSync(file, '{"type":"stop","taskId":1,"agentId":"cl');

    const second = new Transcript(file);
    expect(second.all().map((record) => record.type)).toEqual(['user', 'delegation']);
    const next = second.append({ type: 'user', text: 'two' });
    expect(next.seq).toBe(3);
    await second.close();

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3]!)).toMatchObject({ type: 'user', text: 'two', seq: 3 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a resumed-session note from an older run back as the session record it was', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handsfree-transcript-'));
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'note', level: 'info', text: 'resumed claude session c1', seq: 1, at: 1 })}\n` +
        `${JSON.stringify({ type: 'note', level: 'info', text: 'wrote notes.txt', seq: 2, at: 2 })}\n`,
    );
    const replayed = new Transcript(file);
    expect(replayed.all()[0]).toMatchObject({ type: 'session', agentId: 'claude', sessionId: 'c1', how: 'resumed', seq: 1 });
    expect(replayed.all()[1]).toMatchObject({ type: 'note', text: 'wrote notes.txt' });
    await replayed.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty where there is no file yet', () => {
    expect(new Transcript().all()).toEqual([]);
  });
});
