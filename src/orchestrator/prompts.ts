import type { AgentName, Config } from '../config/schema.js';
import type { TaskPaths } from '../workspace/session.js';
import { renderTurnFacts, type TurnTask } from './turn.js';

const AGENT_NOTES: Record<AgentName, string> = {
  claude: 'strong general coding agent; can read/write/edit files in the workspace',
  gemini: 'can ONLY create and edit files (no shell commands at all)',
  codex: 'coding agent in a sandbox; can write files and run commands inside the workspace, no network',
};

export function buildSystemPrompt(config: Config): string {
  const enabled = (Object.keys(config.agents) as AgentName[]).filter(
    (name) => config.agents[name].enabled,
  );
  const agentLines = enabled.map((name) => `- "${name}": ${AGENT_NOTES[name]}`).join('\n');
  return `You are handsfree, an orchestrator. You either answer the user directly or delegate ONE coding task at a time to an agent.

Agents available:
${agentLines}

Rules:
- Agents work ONLY inside a workspace directory. They cannot install packages or access the network. Denied operations fail; they are never approved interactively.
- Write tasks as short, self-contained imperative briefs. Include exact file names and exact content when the user specified them.
- Delegate anything that involves creating or changing files or code. Answer directly for questions and conversation.
- Once the tasks you delegated are done, respond with a summary of what each task actually did — files created or changed, and anything that failed. Never end a delegation with a bare "done".
- If a task result has status "blocked_by_permissions", retry ONCE with the task rephrased to use only file create/edit operations. If blocked again, tell the user what was denied.
- Reply with EXACTLY ONE JSON object and nothing else. Two forms:
{"action":"respond","message":"<your reply to the user>"}
{"action":"delegate","agent":"claude","task":"<imperative brief>","done_when":"<observable success condition>"}

Examples:
User: hi there
{"action":"respond","message":"Hi! Tell me what you'd like done and I'll handle it."}
User: make a file called notes.txt saying hello world
{"action":"delegate","agent":"claude","task":"Create a file named notes.txt in the current directory containing exactly: hello world","done_when":"notes.txt exists with that content"}`;
}

export function buildBrief(
  agent: AgentName,
  task: string,
  doneWhen: string | undefined,
  taskPaths: TaskPaths,
  contextRelPath: string,
): string {
  const capability: Record<AgentName, string> = {
    claude:
      'You may read, create and edit files in the current directory. Do not attempt operations that need extra approval.',
    gemini:
      'Use file write/edit tools ONLY. Do not run shell commands — they will be denied.',
    codex:
      'You may write files and run commands inside the current directory sandbox. No network access.',
  };
  return `# Task ${taskPaths.id}

${task}
${doneWhen ? `\nDone when: ${doneWhen}\n` : ''}
## Constraints
- Work only in the current directory.
- ${capability[agent]}
- Do only this task; do not expand scope.
- Prior task context (if any) is in ${contextRelPath} and tasks/*/result.md.
- When finished, write a short summary of what you did to ${taskPaths.dir}/result.md
`;
}

export function buildDelegatePrompt(taskPaths: TaskPaths, runDir: string): string {
  return `Read the task brief at ${taskPaths.briefFile} and complete it. Work in the current directory (${runDir}). When finished, write a short summary of what you did to ${taskPaths.resultFile}`;
}

/**
 * A separate persona from the orchestrator prompt above: this one writes prose to
 * the user, not JSON actions, and is deliberately fenced off from the action
 * schema so a small model does not answer a summary request with a delegation.
 */
export function buildSummarySystemPrompt(): string {
  return `You are handsfree, reporting back to the user after delegated coding tasks have finished.

Write plain prose. No JSON, no code fences, no preamble.

Rules:
- Report what was actually done, task by task, in the past tense.
- Name the files that were created or changed, when the results mention them.
- State failures, timeouts and permission blocks plainly. Never describe a task as done when its status says otherwise.
- Use only the facts given to you. Do not invent work, file names or outcomes.
- At most three sentences per task.`;
}

export function buildSummaryRequest(
  userMessage: string,
  tasks: TurnTask[],
  notes: string[],
): string {
  return `The user asked:
${userMessage}

Here is exactly what happened:

${renderTurnFacts(tasks, notes)}

Report back to the user.`;
}
