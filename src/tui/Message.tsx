import React from 'react';
import { Box, Text } from 'ink';
import type { ChatItem } from './useOrchestrator.js';
import { STATUS_COLOR, STATUS_LABEL, summarize } from './format.js';
import { BULLET, BULLET_WIDTH, ELBOW, ELBOW_WIDTH, POINTER } from './figures.js';

/**
 * A line handsfree owns: `⏺ …`. The gutter is its own fixed-width box so a
 * wrapped or multi-line body stays flush under the first character rather than
 * sliding back to column zero.
 */
export function Bullet({ color, children }: { color?: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box flexShrink={0} minWidth={BULLET_WIDTH}>
        <Text color={color}>{BULLET}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

/** The `⎿` continuation hanging off the bullet above it — outcomes, output, command results. */
export function Response({ children }: { children: React.ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box flexShrink={0} minWidth={ELBOW_WIDTH}>
        <Text dimColor>{'  '}{ELBOW}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

/** `agent(what it was asked to do)` — the delegation's one-line signature. */
export function TaskSignature({ agent, id, task }: { agent: string; id: number; task: string }) {
  return (
    <Text wrap="truncate-end">
      <Text bold>{agent}</Text>
      <Text dimColor>
        (#{id} {summarize(task)})
      </Text>
    </Text>
  );
}

/**
 * One scrollback entry. Every entry is preceded by a blank line, so blocks stay
 * separable. Memoized because the transcript is now re-rendered on every frame
 * rather than handed off to the terminal — items are frozen once appended, so a
 * spinner tick shouldn't walk the whole history.
 */
export const Message = React.memo(function Message({ item }: { item: ChatItem }) {
  return <Box flexDirection="column" marginTop={1}>{renderBody(item)}</Box>;
});

function renderBody(item: ChatItem) {
  switch (item.kind) {
    case 'user':
      return (
        <Box flexDirection="row">
          <Box flexShrink={0} minWidth={BULLET_WIDTH}>
            <Text dimColor>{POINTER}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Text>{item.text}</Text>
          </Box>
        </Box>
      );

    case 'assistant':
      return (
        <Bullet>
          <Text>{item.text}</Text>
        </Bullet>
      );

    case 'task':
      return (
        <>
          {/* A finished delegation keeps the plain bullet; only a bad outcome earns a color. */}
          <Bullet color={item.status === 'success' ? undefined : STATUS_COLOR[item.status]}>
            <TaskSignature agent={item.agent} id={item.id} task={item.text} />
          </Bullet>
          <Response>
            <Text>
              <Text color={STATUS_COLOR[item.status]}>{STATUS_LABEL[item.status]}</Text>
              <Text dimColor> ({item.elapsed})</Text>
            </Text>
          </Response>
        </>
      );

    case 'error':
      return (
        <Bullet color="red">
          <Text color="red">{item.text}</Text>
        </Bullet>
      );

    case 'info':
      return (
        <Response>
          <Text dimColor>{item.text}</Text>
        </Response>
      );
  }
}
