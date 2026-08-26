import { useEffect, useMemo, useReducer } from 'react';
import type { AgentName, Config } from '../config/schema.js';
import type { TaskStatus } from '../agents/types.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { formatDuration } from './format.js';

/**
 * One entry in the scrollback. Kept structured rather than pre-formatted so the
 * renderer owns the layout — a delegation prints as a bullet line plus an
 * indented outcome, which no single string can express.
 */
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'info'; text: string }
  | {
      kind: 'task';
      /** The delegated prompt, shown inside `agent(…)`. */
      text: string;
      agent: AgentName;
      id: number;
      status: TaskStatus;
      elapsed: string;
    };

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
  /** Messages typed while a turn was running, waiting their turn. */
  queued: string[];
  runDir: string;
  /** Bumped on /clear so <Static> remounts with a fresh item index. */
  generation: number;
}

type TuiEvent =
  | { type: 'queue_message'; text: string }
  | { type: 'start_queued' }
  | { type: 'assistant_text'; text: string }
  | { type: 'task_started'; id: number; agent: AgentName; task: string }
  | { type: 'task_output_chunk'; chunk: string }
  | { type: 'task_finished'; id: number; agent: AgentName; status: TaskStatus }
  | { type: 'error'; message: string }
  | { type: 'info'; text: string }
  | { type: 'clear' }
  | { type: 'turn_done' };

const TAIL_LINES = 8;

/**
 * Chatty CLIs emit output faster than a terminal can usefully redraw. Coalescing
 * into one dispatch per interval keeps the task panel readable and the render
 * cost bounded, at the price of up to this much lag on the live tail.
 */
const CHUNK_FLUSH_MS = 100;

/** Upper bound on chunks held between flushes, so a burst cannot grow unbounded. */
const CHUNK_BUFFER_MAX = 200;

export function initialTuiState(runDir: string): TuiState {
  return { items: [], phase: 'idle', tasks: [], queued: [], runDir, generation: 0 };
}

/** Exported for tests: the whole TUI state machine, with no orchestrator attached. */
export function reducer(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case 'queue_message':
      return { ...state, queued: [...state.queued, event.text] };
    case 'start_queued': {
      const [next, ...rest] = state.queued;
      if (next === undefined) return state;
      return {
        ...state,
        queued: rest,
        phase: 'thinking',
        items: [...state.items, { kind: 'user', text: next }],
      };
    }
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
      return {
        ...state,
        phase: 'thinking',
        activeTask: undefined,
        tasks,
        items: [
          ...state.items,
          {
            kind: 'task',
            text: record?.task ?? '',
            agent: event.agent,
            id: event.id,
            status: event.status,
            elapsed,
          },
        ],
      };
    }
    case 'error':
      return { ...state, items: [...state.items, { kind: 'error', text: event.message }] };
    case 'info':
      return { ...state, items: [...state.items, { kind: 'info', text: event.text }] };
    case 'clear':
      return {
        ...state,
        items: [],
        tasks: [],
        queued: [],
        phase: 'idle',
        activeTask: undefined,
        generation: state.generation + 1,
      };
    case 'turn_done':
      return { ...state, phase: 'idle', activeTask: undefined };
  }
}

export function useOrchestrator(config: Config) {
  const orchestrator = useMemo(() => new Orchestrator(config), [config]);
  const [state, dispatch] = useReducer(reducer, initialTuiState(orchestrator.session.runDir));

  useEffect(() => {
    let buffer: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (buffer.length === 0) return;
      const chunk = buffer.join('');
      buffer = [];
      dispatch({ type: 'task_output_chunk', chunk });
    };

    orchestrator.on('assistant_text', (text) => dispatch({ type: 'assistant_text', text }));
    orchestrator.on('task_started', (info) => dispatch({ type: 'task_started', ...info }));
    orchestrator.on('task_output_chunk', ({ chunk }) => {
      buffer.push(chunk);
      if (buffer.length > CHUNK_BUFFER_MAX) buffer = buffer.slice(-CHUNK_BUFFER_MAX);
      if (!timer) timer = setTimeout(flush, CHUNK_FLUSH_MS);
    });
    orchestrator.on('task_finished', (info) => {
      // Show the tail end of the output before the panel goes away.
      if (timer) clearTimeout(timer);
      flush();
      dispatch({ type: 'task_finished', ...info });
    });
    orchestrator.on('error', (message) => dispatch({ type: 'error', message }));
    orchestrator.on('turn_done', () => dispatch({ type: 'turn_done' }));
    return () => {
      if (timer) clearTimeout(timer);
      orchestrator.removeAllListeners();
    };
  }, [orchestrator]);

  // Messages typed mid-turn wait here rather than being dropped on the floor.
  useEffect(() => {
    if (state.phase !== 'idle' || state.queued.length === 0) return;
    const next = state.queued[0];
    dispatch({ type: 'start_queued' });
    void orchestrator.handleUserMessage(next);
  }, [orchestrator, state.phase, state.queued]);

  const send = (text: string) => dispatch({ type: 'queue_message', text });
  const cancel = () => orchestrator.cancelActiveTask();
  const addInfo = (text: string) => dispatch({ type: 'info', text });
  const clear = () => {
    orchestrator.resetConversation();
    dispatch({ type: 'clear' });
  };

  return { state, send, cancel, addInfo, clear };
}
