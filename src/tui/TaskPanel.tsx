import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ActiveTask } from './useOrchestrator.js';
import { formatDuration } from './format.js';
import { Bullet, Response, TaskSignature } from './Message.js';

/** Re-render once a second so elapsed times tick while a task runs. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The delegation in flight. Rendered in the same bullet/elbow shape the finished
 * ones settle into, so the transcript doesn't jump when the task lands — only
 * the outcome line is replaced. Earlier tasks are already in the scrollback, so
 * this shows the active one alone.
 */
export function TaskPanel({ task, scope }: { task: ActiveTask; scope: string }) {
  const now = useNow(true);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Bullet color="yellow">
        <TaskSignature agent={task.agent} id={task.id} task={task.task} />
      </Bullet>
      <Response>
        <Text>
          <Text color="yellow">Running…</Text>
          <Text dimColor> ({formatDuration(now - task.startedAt)} · esc to interrupt)</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {scope}
        </Text>
        {task.outputTail.map((line, i) => (
          <Text key={i} dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Response>
    </Box>
  );
}
