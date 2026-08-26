import React, { useEffect, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import type { Config } from '../config/schema.js';
import { useOrchestrator, type ChatItem } from './useOrchestrator.js';
import { formatAgents, formatHelp, formatStatus, formatTasks, matchCommands, resolveCommand } from './commands.js';
import { CommandMenu } from './CommandMenu.js';
import { TaskPanel } from './TaskPanel.js';
import { Message } from './Message.js';
import { POINTER } from './figures.js';

type StaticEntry = { banner: true } | ChatItem;

function Banner({ config, runDir }: { config: Config; runDir: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>
        <Text color="cyan">✻ </Text>
        <Text bold>handsfree</Text>
      </Text>
      <Text dimColor>
        {config.llm.model} @ {config.llm.baseURL}
      </Text>
      <Text dimColor>run dir: {runDir}</Text>
      <Text dimColor>type / for commands · Esc cancels the running turn</Text>
    </Box>
  );
}

export function App({ config }: { config: Config }) {
  const { exit } = useApp();
  const { state, send, cancel, addInfo, clear } = useOrchestrator(config);
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  /** Position in `history` while recalling, or null when editing a fresh line. */
  const [recall, setRecall] = useState<number | null>(null);
  /** The half-typed line stashed when recall started, restored on the way back. */
  const [draft, setDraft] = useState('');

  const menuOpen = input.startsWith('/');
  const suggestions = menuOpen ? matchCommands(input) : [];

  useEffect(() => {
    setSelected(0);
  }, [input]);

  const recallHistory = (delta: number) => {
    if (history.length === 0) return;
    if (recall === null) {
      if (delta > 0) return; // Nothing newer than the line being typed.
      setDraft(input);
      const index = history.length - 1;
      setRecall(index);
      setInput(history[index]);
      return;
    }
    const index = recall + delta;
    if (index >= history.length) {
      setRecall(null);
      setInput(draft);
      return;
    }
    const clamped = Math.max(0, index);
    setRecall(clamped);
    setInput(history[clamped]);
  };

  useInput((_input, key) => {
    if (key.escape) {
      // Cancels the whole turn, including a local-LLM call that has not returned.
      if (state.phase !== 'idle') cancel();
      else if (input !== '') setInput('');
      return;
    }
    if (key.tab && suggestions.length > 0) {
      setInput(`/${suggestions[Math.min(selected, suggestions.length - 1)].name}`);
      return;
    }
    // Once you are browsing history, ↑/↓ stay in history — even though recalling a
    // slash command pops the menu open underneath.
    if (recall === null && suggestions.length > 0) {
      if (key.upArrow) setSelected((s) => (s + suggestions.length - 1) % suggestions.length);
      else if (key.downArrow) setSelected((s) => (s + 1) % suggestions.length);
      return;
    }
    if (key.upArrow) recallHistory(-1);
    else if (key.downArrow) recallHistory(1);
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
    setRecall(null);
    setDraft('');
    setHistory((h) => (h.at(-1) === text ? h : [...h, text]));
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

  const doneCount = state.tasks.filter((t) => t.status !== 'running').length;

  const staticEntries: StaticEntry[] = [{ banner: true }, ...state.items];

  return (
    <Box flexDirection="column">
      <Static key={state.generation} items={staticEntries}>
        {(entry, i) =>
          'banner' in entry ? (
            <Banner key="banner" config={config} runDir={state.runDir} />
          ) : (
            <Message key={i} item={entry} />
          )
        }
      </Static>

      {state.activeTask && <TaskPanel task={state.activeTask} scope={scope} />}

      {state.phase === 'thinking' && (
        <Box marginTop={1} gap={1}>
          <Spinner type="dots" />
          <Text dimColor>Thinking…</Text>
        </Box>
      )}

      {/* The input stays live during a turn; what you type is queued, not dropped. */}
      <Box marginTop={1} gap={1}>
        <Text color="cyan" bold>
          {POINTER}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={
            state.phase === 'idle'
              ? 'describe a task, or / for commands'
              : 'working… type ahead and it runs next'
          }
        />
      </Box>

      {state.queued.map((text, i) => (
        <Box key={i} paddingLeft={2} gap={1}>
          <Text dimColor>queued</Text>
          <Text dimColor wrap="truncate-end">
            {text}
          </Text>
        </Box>
      ))}

      {menuOpen ? (
        <CommandMenu commands={suggestions} selected={Math.min(selected, Math.max(0, suggestions.length - 1))} />
      ) : (
        <Box paddingLeft={2} gap={2}>
          <Text dimColor>/ for commands · ↑ for history</Text>
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
