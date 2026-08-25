import React from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from './commands.js';

const NAME_WIDTH = 9;

/** Dropdown shown under the input while typing a "/" command. */
export function CommandMenu({ commands, selected }: { commands: SlashCommand[]; selected: number }) {
  if (commands.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>no matching command</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {commands.map((c, i) => {
        const active = i === selected;
        return (
          <Box key={c.name} gap={1}>
            <Text color="cyan" inverse={active} bold={active}>
              {`/${c.name}`.padEnd(NAME_WIDTH)}
            </Text>
            <Text dimColor={!active}>{c.description}</Text>
          </Box>
        );
      })}
      <Text dimColor>↑/↓ select · Tab complete · Enter run</Text>
    </Box>
  );
}
