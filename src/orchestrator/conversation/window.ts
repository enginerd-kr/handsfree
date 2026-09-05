import type { ChatMessage } from '../../models/client.js';

/** Recovery view only. The caller persists an exact checkpoint before using it. */
export function recoverWindow(messages: readonly ChatMessage[], checkpoint: number): ChatMessage[] | undefined {
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  const current = messages.findIndex((message) => message.pinned);
  const previousAnswer = messages.slice(0, current < 0 ? messages.length : current)
    .findLastIndex((message) => message.role === 'assistant');
  const latest = new Map<string, number>();
  messages.forEach((message, index) => message.agents?.forEach((agent) => latest.set(agent, index)));
  const paired = new Set<number>();
  for (const index of latest.values()) {
    for (let prior = index - 1; prior >= 0; prior--) {
      if (messages[prior]?.role === 'assistant') { paired.add(prior); break; }
    }
  }
  // Preserve the entire result group for any retained assistant call. A
  // multi-call response must not survive with only some of its replies.
  for (const start of [...paired]) {
    for (let index = start + 1; index < messages.length && messages[index]?.role !== 'assistant'; index++) paired.add(index);
  }
  const kept: ChatMessage[] = [];
  messages.forEach((message, index) => {
    const userRequest = message.role === 'user' && !message.content.startsWith('TOOL RESULT') && !message.content.startsWith('HISTORY CHECKPOINT');
    if (message.role === 'system' || message.pinned || userRequest || index >= lastAssistant || index === previousAnswer
      || paired.has(index) || message.agents?.some((agent) => latest.get(agent) === index)) {
      // Keep the most recent arguments verbatim. Pinned requests shed only
      // their optional ledger, never the request, constraints or saved plan.
      kept.push(message.requiredContent ? { ...message, content: message.requiredContent } : message);
    }
  });
  const note: ChatMessage = { role: 'user', content: `HISTORY CHECKPOINT: record:${checkpoint}. Older exchanges were removed from this active window after a context overflow. Their exact text is stored in context.read; use offset and maxChars to retrieve selected pages. Current requests, constraints and the latest worker replies are retained. Retrieve earlier evidence before making claims that depend on it.` };
  kept.splice(kept[0]?.role === 'system' ? 1 : 0, 0, note);
  return kept.reduce((sum, message) => sum + message.content.length, 0) < messages.reduce((sum, message) => sum + message.content.length, 0)
    ? kept : undefined;
}
