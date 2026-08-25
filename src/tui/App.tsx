import React, { useEffect, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { Config } from '../config/schema.js';
import { useOrchestrator, type ChatItem } from './useOrchestrator.js';
import { formatAgents, formatHelp, formatStatus, formatTasks, matchCommands, resolveCommand } from './commands.js';
import { CommandMenu } from './CommandMenu.js';
import { TaskPanel } from './TaskPanel.js';

const ITEM_COLORS: Record<ChatItem['kind'], string | undefined> = {
  user: 'cyan',
  assistant: undefined,
  task: 'yellow',
  error: 'red',
  info: undefined,
};

const ITEM_PREFIX: Record<ChatItem['kind'], string> = {
  user: 'you ',
  assistant: '  hf',
  task: 'task',
  error: ' err',
  info: '    ',
};

type StaticEntry = { banner: true } | ChatItem;

function Banner({ config, runDir }: { config: Config; runDir: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">
        handsfree
      </Text>
      <Text dimColor>
        {config.llm.model} @ {config.llm.baseURL}
      </Text>
      <Text dimColor>run dir: {runDir}</Text>
      <Text dimColor>type / for commands · Esc cancels a running task</Text>
    </Box>
  );
}

function ChatLine({ item }: { item: ChatItem }) {
  if (item.kind === 'info') {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>{item.text}</Text>
      </Box>
    );
  }
  const color = item.color ?? ITEM_COLORS[item.kind];
  return (
    <Box gap={1}>
      <Text color={color} bold>
        {ITEM_PREFIX[item.kind]}
      </Text>
      <Text color={color}>{item.text}</Text>
    </Box>
  );
}

export function App({ config }: { config: Config }) {
  const { exit } = useApp();
  const { state, send, cancel, addInfo, clear } = useOrchestrator(config);
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState(0);

  const menuOpen = state.phase === 'idle' && input.startsWith('/');
  const suggestions = menuOpen ? matchCommands(input) : [];

  useEffect(() => {
    setSelected(0);
  }, [input]);

  useInput((_input, key) => {
    if (key.escape) {
      if (state.phase === 'delegating') cancel();
      else if (input !== '') setInput('');
      return;
    }
    if (suggestions.length > 0) {
      if (key.upArrow) setSelected((s) => (s + suggestions.length - 1) % suggestions.length);
      else if (key.downArrow) setSelected((s) => (s + 1) % suggestions.length);
      else if (key.tab) setInput(`/${suggestions[Math.min(selected, suggestions.length - 1)].name}`);
    }
  });

  const runCommand = (name: string) => {
    switch (name) {
      case 'help':
        addInfo(formatHelp());
        break;
      case 'tasks':
        addInfo(formatTasks(state.tasks));
        break;
      case 'agents':
        addInfo(formatAgents(config));
        break;
      case 'status':
        addInfo(formatStatus(config, state.runDir, state.tasks));
        break;
      case 'clear':
        clear();
        break;
      case 'exit':
        exit();
        break;
    }
  };

  const onSubmit = (value: string) => {
    const text = value.trim();
    if (text === '') return;
    setInput('');
    if (text.startsWith('/')) {
      const command = resolveCommand(text) ?? suggestions[Math.min(selected, Math.max(0, suggestions.length - 1))];
      if (!command) {
        addInfo(`Unknown command: ${text} — try /help`);
        return;
      }
      runCommand(command.name);
      return;
    }
    send(text);
  };

  const scope = state.activeTask
    ? {
        claude: `acceptEdits · ${config.agents.claude.allowedTools.join(',')}`,
        gemini: `approval:${config.agents.gemini.approvalMode}`,
        codex: `sandbox:${config.agents.codex.sandbox}`,
      }[state.activeTask.agent]
    : '';

  const turnTasks = state.tasks.slice(-4);
  const doneCount = state.tasks.filter((t) => t.status !== 'running').length;

  const staticEntries: StaticEntry[] = [{ banner: true }, ...state.items];

  return (
    <Box flexDirection="column">
      <Static key={state.generation} items={staticEntries}>
        {(entry, i) =>
          'banner' in entry ? (
            <Banner key="banner" config={config} runDir={state.runDir} />
          ) : (
            <ChatLine key={i} item={entry} />
          )
        }
      </Static>

      {state.activeTask && <TaskPanel task={state.activeTask} scope={scope} turnTasks={turnTasks} />}

      {state.phase === 'thinking' && (
        <Box gap={1}>
          <Spinner type="dots" />
          <Text dimColor>thinking…</Text>
        </Box>
      )}

      <Box gap={1}>
        <Text color="cyan" bold>
          ›
        </Text>
        {state.phase === 'idle' ? (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            placeholder="describe a task, or / for commands"
          />
        ) : (
          <Text dimColor>working…</Text>
        )}
      </Box>

      {menuOpen ? (
        <CommandMenu commands={suggestions} selected={Math.min(selected, Math.max(0, suggestions.length - 1))} />
      ) : (
        <Box paddingLeft={2} gap={2}>
          <Text dimColor>/ for commands</Text>
          {state.tasks.length > 0 && (
            <Text dimColor>
              tasks: {doneCount}/{state.tasks.length} done
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
