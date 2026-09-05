import React, { useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import type { Config } from '../../config/schema.js';
import { modelDefaults, type ModelDefaults } from '../../config/models.js';
import type { ModelChoice } from '../../host/models.js';
import { scoreModel } from '../../host/models.js';
import { agentColour, BRAND, INK } from './theme.js';
import { isTerminalReport } from './keys.js';

interface Props {
  config: Config;
  file: string;
  models: Record<string, readonly ModelChoice[]>;
  rows: number;
  columns: number;
  onSave: (before: ModelDefaults, next: ModelDefaults) => void;
  onClose: () => void;
}

interface Editor {
  id: string;
  value: string;
  cursor: number;
  selected: number;
}

interface State {
  defaults: ModelDefaults;
  selected: number;
  editor?: Editor;
  error?: string;
}

const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const clean = (text: string): string => text.replace(/[\x00-\x20\x7f-\x9f]/g, '');

/** A separate Ink input seat: all edits stay in a draft until Save defaults. */
export function ModelSettings({ config, file, models, rows, columns, onSave, onClose }: Props): React.JSX.Element {
  const [before] = useState(() => modelDefaults(config));
  const [state, setState] = useState<State>(() => ({ defaults: structuredClone(before), selected: 0 }));
  // Ink may deliver several keys before React draws the next frame.
  const ref = useRef(state);
  const update = (next: State) => { ref.current = next; setState(next); };
  const agentIds = [...new Set(['claude', 'codex', 'gemini', ...Object.keys(config.agents)])];
  const sources = [
    { value: 'local', label: 'Local endpoint' },
    { value: 'api', label: 'API endpoint' },
    ...Object.entries(config.agents).filter(([, profile]) => profile.enabled)
      .map(([id]) => ({ value: `acp:${id}`, label: `${LABELS[id] ?? id} (ACP)` })),
  ];
  const sourceOf = (d: ModelDefaults) => d.provider === 'acp' ? `acp:${d.agent}` : d.provider;
  const fields = ['source', 'orchestrator', ...agentIds, 'save'];
  const title = (id: string) => id === 'orchestrator' ? 'Orchestrator model' : `${LABELS[id] ?? id} model`;
  const defaultLabel = (id: string, d: ModelDefaults): string => id === 'orchestrator'
    ? `Agent default${d.agents[d.agent] ? ` (${d.agents[d.agent]})` : ''}` : 'CLI default';
  const canReset = (id: string, d: ModelDefaults) => id !== 'orchestrator' || d.provider === 'acp';
  const choicesFor = (s: State): ModelChoice[] => {
    const editor = s.editor;
    if (!editor) return [];
    const id = editor.id === 'orchestrator'
      ? s.defaults.provider === 'acp' ? s.defaults.agent : undefined : editor.id;
    const offered = id ? models[id] ?? [] : [];
    return [
      ...(canReset(editor.id, s.defaults) ? [{ value: '', description: defaultLabel(editor.id, s.defaults) }] : []),
      ...offered.filter((choice) => scoreModel(editor.value, choice.value) !== undefined),
    ];
  };
  const insert = (text: string) => {
    const s = ref.current;
    if (!s.editor) return;
    const chars = [...s.editor.value];
    const added = [...clean(text)];
    chars.splice(s.editor.cursor, 0, ...added);
    update({ ...s, error: undefined, editor: { ...s.editor, value: chars.join(''), cursor: s.editor.cursor + added.length, selected: -1 } });
  };
  usePaste(insert);
  useInput((input, key) => {
    if (isTerminalReport(input)) return;
    const s = ref.current;
    const editor = s.editor;
    if (key.escape) {
      if (editor) update({ ...s, editor: undefined, error: undefined });
      else onClose();
      return;
    }
    if (editor) {
      const choices = choicesFor(s);
      if (key.upArrow || key.downArrow || key.tab) {
        const by = key.upArrow || key.shift ? -1 : 1;
        const selected = ((editor.selected + 1 + by + choices.length + 1) % (choices.length + 1)) - 1;
        update({ ...s, editor: { ...editor, selected } });
        return;
      }
      if (key.return) {
        const value = (editor.selected < 0 ? editor.value : choices[editor.selected]?.value ?? editor.value).trim();
        if (!value && !canReset(editor.id, s.defaults)) {
          update({ ...s, error: 'Enter a model ID for the endpoint.' });
          return;
        }
        const defaults = structuredClone(s.defaults);
        if (editor.id === 'orchestrator') {
          if (defaults.provider === 'acp') defaults.acp = value;
          else defaults.local = value;
        } else defaults.agents[editor.id] = value;
        update({ ...s, defaults, editor: undefined, error: undefined });
        return;
      }
      if (key.ctrl && (input === 'u' || input === 'a' || input === 'e')) {
        const value = input === 'u' ? '' : editor.value;
        update({ ...s, editor: { ...editor, value, cursor: input === 'e' ? [...value].length : 0, selected: -1 } });
        return;
      }
      if (key.leftArrow || key.rightArrow || key.home || key.end) {
        const length = [...editor.value].length;
        const cursor = key.home ? 0 : key.end ? length : Math.max(0, Math.min(length, editor.cursor + (key.leftArrow ? -1 : 1)));
        update({ ...s, editor: { ...editor, cursor, selected: -1 } });
        return;
      }
      if (key.backspace || key.delete) {
        const chars = [...editor.value];
        const cursor = Math.max(0, editor.cursor - (key.backspace ? 1 : 0));
        if (!key.backspace || editor.cursor > 0) chars.splice(cursor, 1);
        update({ ...s, editor: { ...editor, value: chars.join(''), cursor, selected: -1 } });
        return;
      }
      if (!key.ctrl && !key.meta && input) insert(input);
      return;
    }
    if (key.upArrow || key.downArrow || key.tab) {
      const by = key.upArrow || key.shift ? -1 : 1;
      update({ ...s, selected: (s.selected + by + fields.length) % fields.length, error: undefined });
      return;
    }
    const id = fields[s.selected]!;
    if (id === 'source' && (key.return || key.leftArrow || key.rightArrow)) {
      const by = key.leftArrow ? -1 : 1;
      const at = sources.findIndex((source) => source.value === sourceOf(s.defaults));
      const source = sources[(at + by + sources.length) % sources.length]!;
      const defaults = { ...s.defaults };
      if (source.value.startsWith('acp:')) {
        defaults.provider = 'acp';
        defaults.agent = source.value.slice(4);
        if (defaults.agent !== s.defaults.agent) defaults.acp = '';
      } else defaults.provider = source.value as 'local' | 'api';
      update({ ...s, defaults, error: undefined });
      return;
    }
    if ((key.ctrl && input === 's') || (key.return && id === 'save')) {
      try { onSave(before, s.defaults); }
      catch (err) { update({ ...s, error: (err as Error).message }); }
      return;
    }
    if (key.return && id !== 'source') {
      if (id !== 'orchestrator' && !config.agents[id]) {
        update({ ...s, error: `${LABELS[id] ?? id} is not configured. Add its launch profile to the settings file.` });
        return;
      }
      const value = id === 'orchestrator'
        ? s.defaults.provider === 'acp' ? s.defaults.acp : s.defaults.local : s.defaults.agents[id] ?? '';
      update({ ...s, editor: { id, value, cursor: [...value].length, selected: -1 }, error: undefined });
    }
  });

  const { defaults, editor } = state;
  const choices = choicesFor(state);
  const changed = JSON.stringify(before) !== JSON.stringify(defaults);
  const room = Math.max(1, rows - (editor ? 13 : 10));
  const from = Math.max(0, (editor?.selected ?? state.selected) - room + 1);
  const valueFor = (id: string): string => {
    if (id === 'source') return `‹ ${sources.find((source) => source.value === sourceOf(defaults))?.label ?? sourceOf(defaults)} ›`;
    if (id === 'save') return changed ? 'Save defaults *' : 'Save defaults';
    if (id === 'orchestrator') return (defaults.provider === 'acp' ? defaults.acp : defaults.local) || defaultLabel(id, defaults);
    if (!config.agents[id]) return 'Not configured';
    return `${defaults.agents[id] || 'CLI default'}${config.agents[id]?.enabled ? '' : ' (disabled)'}`;
  };
  const chars = [...(editor?.value ?? '')];
  const cursor = editor?.cursor ?? 0;
  const inputStart = Math.max(0, cursor - Math.max(4, Math.floor((columns - 12) / 2)));
  return (
    <Box flexDirection="column" height={Math.max(1, rows - 1)} paddingX={2} overflow="hidden">
      <Box marginTop={1}><Text bold color={BRAND}>Model settings{changed ? ' *' : ''}</Text></Box>
      <Text color={INK} wrap="truncate-middle">{file}</Text>
      <Text color={INK}>Defaults apply to all projects on the next launch.</Text>
      <Box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
        {editor ? <>
          <Text bold color={agentColour(editor.id)}>{title(editor.id)}</Text>
          <Text color={INK} wrap="truncate">Type a model ID, or choose a model below.</Text>
          <Text wrap="truncate">{editor.selected === -1 ? '› ' : '  '}{inputStart ? '…' : ''}{chars.slice(inputStart, cursor).join('')}<Text inverse>{chars[cursor] ?? ' '}</Text>{chars.slice(cursor + 1).join('')}</Text>
          <Text color={INK}>{canReset(editor.id, defaults) ? 'Empty = default · ctrl+u clears the field' : 'Use the model ID from your configured endpoint.'}</Text>
          {choices.length === 0 && <Text color={INK}>No model list available; enter the ID directly.</Text>}
          {choices.slice(from, from + room).map((choice, index) => <Text key={choice.value} color={editor.selected === from + index ? BRAND : INK} wrap="truncate">
            {editor.selected === from + index ? '› ' : '  '}{choice.value || choice.description}{choice.value && choice.description ? ` — ${choice.description}` : ''}
          </Text>)}
        </> : fields.slice(from, from + room).map((id, index) => <Box key={id} flexShrink={0}>
          <Text color={BRAND}>{state.selected === from + index ? '› ' : '  '}</Text>
          {id !== 'save' && <Box width={Math.min(23, Math.floor(columns / 2))} flexShrink={0}><Text color={agentColour(id)} wrap="truncate">{id === 'source' ? 'Orchestrator source' : title(id)}</Text></Box>}
          <Text bold={id === 'save'} color={state.selected === from + index ? BRAND : INK} wrap="truncate">{valueFor(id)}</Text>
        </Box>)}
      </Box>
      <Text color={state.error ? 'red' : INK} wrap="truncate">{state.error ?? (editor ? '↑↓ select · enter apply · esc back' : '↑↓ / tab move · enter edit · ←→ source')}</Text>
      <Text color={INK}>{editor ? 'Changes are kept until you save the settings.' : 'ctrl+s save · esc discard and return'}</Text>
    </Box>
  );
}
