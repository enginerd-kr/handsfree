import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { agentText, Transcript } from '../src/workspace/transcript.js';
import { parseReport } from '../src/orchestrator/results/report.js';

function updates(...list: SessionUpdate[]): Transcript {
  const transcript = new Transcript();
  for (const update of list) {
    transcript.append({ type: 'session_update', agentId: 'claude', sessionId: 's', update });
  }
  return transcript;
}

describe('agent message assembly', () => {
  it('preserves report boundaries after tool exchanges without splitting streamed words', () => {
    const transcript = updates(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will run the tests.' } },
      { sessionUpdate: 'tool_call', toolCallId: 'test', title: 'node --test', kind: 'execute', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'test', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REP' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ORT\noutcome: blocked\nsummary: Need input\nopen: - missing schema\nverify: node --test' } },
    );
    const text = agentText(transcript.all());
    expect(text).toContain('tests.\n\nREPORT\n');
    expect(parseReport(text)).toMatchObject({ structured: true, outcome: 'blocked', open: ['missing schema'], verify: 'node --test' });
  });
});
