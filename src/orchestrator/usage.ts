import type { ChatClient, Usage } from '../brain/client.js';
import { debug } from '../debug.js';
import type { Transcript } from '../workspace/transcript.js';

/**
 * The orchestration model, with every call written down: how much was sent,
 * how much came back, and the endpoint's own token count where it gives one.
 * The point of a small planner is that planning stays small, and the only way
 * to know it has is to be able to read the figure after the fact.
 */
export function metered(llm: ChatClient, purpose: 'plan' | 'narrate', transcript: Transcript): ChatClient {
  return {
    async chat(messages, options = {}) {
      const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
      let usage: Usage | undefined;
      const reply = await llm.chat(messages, {
        ...options,
        onUsage: (counted) => {
          usage = counted;
          options.onUsage?.(counted);
        },
      });
      transcript.append({
        type: 'usage',
        purpose,
        promptChars,
        replyChars: reply.length,
        ...(usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : {}),
      });
      debug(
        'llm',
        `${purpose}: ${messages.length} messages, ${promptChars} chars in, ${reply.length} out` +
          (usage ? ` (${usage.promptTokens} + ${usage.completionTokens} tokens)` : ''),
      );
      return reply;
    },
  };
}
