import { useEffect, useMemo, useReducer } from 'react';
import type { AgentName, Config } from '../config/schema.js';
import type { TaskStatus } from '../agents/types.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { formatDuration, STATUS_ICON } from './format.js';

export interface ChatItem {
  kind: 'user' | 'assistant' | 'task' | 'error' | 'info';
  text: string;
  /** Per-item color override (used for task status coloring). */
  color?: string;
}

export interface TaskRecord {
  id: number;
  agent: AgentName;
  task: string;
  status: 'running' | TaskStatus;
  startedAt: number;
  endedAt?: number;
}

export interface ActiveTask {
  id: number;
  agent: AgentName;
  task: string;
  outputTail: string[];
  startedAt: number;
}

export interface TuiState {
  items: ChatItem[];
  phase: 'idle' | 'thinking' | 'delegating';
  activeTask?: ActiveTask;
  tasks: TaskRecord[];
  runDir: string;
  /** Bumped on /clear so <Static> remounts with a fresh item index. */
  generation: number;
}

type TuiEvent =
  | { type: 'user_message'; text: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'task_started'; id: number; agent: AgentName; task: string }
  | { type: 'task_output_chunk'; chunk: string }
  | { type: 'task_finished'; id: number; agent: AgentName; status: TaskStatus }
  | { type: 'error'; message: string }
  | { type: 'info'; text: string }
  | { type: 'clear' }
  | { type: 'turn_done' };

const TAIL_LINES = 8;

const STATUS_ITEM_COLOR: Record<TaskStatus, string> = {
  success: 'green',
  error: 'red',
  timeout: 'magenta',
  blocked_by_permissions: 'yellow',
};

function reducer(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case 'user_message':
      return { ...state, phase: 'thinking', items: [...state.items, { kind: 'user', text: event.text }] };
    case 'assistant_text':
      return { ...state, items: [...state.items, { kind: 'assistant', text: event.text }] };
    case 'task_started': {
      const record: TaskRecord = {
        id: event.id,
        agent: event.agent,
        task: event.task,
        status: 'running',
        startedAt: Date.now(),
      };
      return {
        ...state,
        phase: 'delegating',
        activeTask: { id: event.id, agent: event.agent, task: event.task, outputTail: [], startedAt: record.startedAt },
        tasks: [...state.tasks, record],
      };
    }
    case 'task_output_chunk': {
      if (!state.activeTask) return state;
      const lines = event.chunk.split('\n').filter((l) => l.trim() !== '');
      const outputTail = [...state.activeTask.outputTail, ...lines].slice(-TAIL_LINES);
      return { ...state, activeTask: { ...state.activeTask, outputTail } };
    }
    case 'task_finished': {
      const endedAt = Date.now();
      const tasks = state.tasks.map((t) => (t.id === event.id ? { ...t, status: event.status, endedAt } : t));
      const record = tasks.find((t) => t.id === event.id);
      const elapsed = record ? formatDuration(endedAt - record.startedAt) : '';
      const task = record ? record.task.slice(0, 80) : '';
      return {
        ...state,
        phase: 'thinking',
        activeTask: undefined,
        tasks,
        items: [
          ...state.items,
          {
            kind: 'task',
            color: STATUS_ITEM_COLOR[event.status],
            text: `${STATUS_ICON[event.status]} ${event.agent} #${event.id} ${event.status} in ${elapsed} — ${task}`,
          },
        ],
      };
    }
    case 'error':
      return { ...state, items: [...state.items, { kind: 'error', text: event.message }] };
    case 'info':
      return { ...state, items: [...state.items, { kind: 'info', text: event.text }] };
    case 'clear':
      return { ...state, items: [], tasks: [], phase: 'idle', activeTask: undefined, generation: state.generation + 1 };
    case 'turn_done':
      return { ...state, phase: 'idle', activeTask: undefined };
  }
}

export function useOrchestrator(config: Config) {
  const orchestrator = useMemo(() => new Orchestrator(config), [config]);
  const [state, dispatch] = useReducer(reducer, {
    items: [],
    phase: 'idle',
    tasks: [],
    runDir: orchestrator.session.runDir,
    generation: 0,
  });

  useEffect(() => {
    orchestrator.on('assistant_text', (text) => dispatch({ type: 'assistant_text', text }));
    orchestrator.on('task_started', (info) => dispatch({ type: 'task_started', ...info }));
    orchestrator.on('task_output_chunk', ({ chunk }) => dispatch({ type: 'task_output_chunk', chunk }));
    orchestrator.on('task_finished', (info) => dispatch({ type: 'task_finished', ...info }));
    orchestrator.on('error', (message) => dispatch({ type: 'error', message }));
    orchestrator.on('turn_done', () => dispatch({ type: 'turn_done' }));
    return () => {
      orchestrator.removeAllListeners();
    };
  }, [orchestrator]);

  const send = (text: string) => {
    dispatch({ type: 'user_message', text });
    void orchestrator.handleUserMessage(text);
  };
  const cancel = () => orchestrator.cancelActiveTask();
  const addInfo = (text: string) => dispatch({ type: 'info', text });
  const clear = () => {
    orchestrator.resetConversation();
    dispatch({ type: 'clear' });
  };

  return { state, send, cancel, addInfo, clear };
}
