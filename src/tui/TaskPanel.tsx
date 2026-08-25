import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ActiveTask, TaskRecord } from './useOrchestrator.js';
import { formatDuration, STATUS_COLOR, STATUS_ICON } from './format.js';

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

/** Live panel for the currently running delegation. */
export function TaskPanel({ task, scope, turnTasks }: { task: ActiveTask; scope: string; turnTasks: TaskRecord[] }) {
  const now = useNow(true);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      {turnTasks
        .filter((t) => t.id !== task.id)
        .map((t) => (
          <Box key={t.id} gap={1}>
            <Text color={STATUS_COLOR[t.status]}>{STATUS_ICON[t.status]}</Text>
            <Text dimColor>
              {t.agent} #{t.id} · {t.status} · {formatDuration((t.endedAt ?? now) - t.startedAt)}
            </Text>
          </Box>
        ))}
      <Box gap={1}>
        <Spinner type="dots" />
        <Text bold>
          {task.agent} #{task.id}
        </Text>
        <Text color="yellow">{formatDuration(now - task.startedAt)}</Text>
        <Text dimColor>{scope}</Text>
        <Text dimColor>(Esc to cancel)</Text>
      </Box>
      <Text wrap="truncate-end">{'  '}{task.task}</Text>
      {task.outputTail.map((line, i) => (
        <Text key={i} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
