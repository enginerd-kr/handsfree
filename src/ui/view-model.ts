import path from 'node:path';
import type {
  ContentBlock,
  Diff,
  PlanEntry,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
} from '@agentclientprotocol/sdk';
import { stripReport } from '../orchestrator/report.js';
import { MODE_LABEL } from '../policy/mode.js';
import { shortTokens, tokensOf } from '../orchestrator/usage.js';
import type { TranscriptRecord } from '../workspace/transcript.js';

export type Tone = 'normal' | 'muted' | 'good' | 'bad' | 'warn' | 'accent' | 'brand';

/** The glyph that opens a row. The renderer owns the actual characters. */
export type Marker = 'none' | 'prompt' | 'bullet' | 'tool' | 'thought' | 'result' | 'allowed' | 'refused';

/** A continuation line, rendered under the row's `⎿` gutter. */
export interface ViewLine {
  text: string;
  tone: Tone;
}

export interface ViewItem {
  key: string;
  /** Who is speaking: the user, handsfree itself, an agent, or the machinery. */
  role: 'user' | 'handsfree' | 'agent' | 'system';
  /** How far in the row sits; tool calls sit one level inside the conversation. */
  depth: number;
  marker: Marker;
  markerTone: Tone;
  /** Sits between the marker and the text, dimmed — the agent's name, mostly. */
  label?: string;
  text: string;
  tone: Tone;
  lines: ViewLine[];
  /** Whether the row wants a blank line above it. */
  gap: boolean;
  /**
   * Whose row this is, when it belongs to a delegated agent — the opening and
   * closing rows of a task included. The renderer spends the agent's own
   * colour on it; nothing about the row's shape depends on it.
   */
  agentId?: string;
  /**
   * Whether the text is an agent's own prose rather than something this file
   * shaped. Only prose is markdown; a tool call's title and a decision's
   * summary are already the finished sentence. Role alone cannot say — a tool
   * call and an agent's answer are both `agent` rows wearing a bullet.
   */
  prose?: boolean;
  /**
   * The delegated task this row belongs to, opening and closing rows included.
   * Kept separately from the click target: a tool result folds independently.
   */
  taskId?: number;
  /** The block a click toggles, and whether all its content is visible. */
  fold?: { id: string; expanded: boolean };
}

/** Maximum length of a compact plan headline. */
const MAX_LINE_CHARS = 200;

/**
 * How many lines of one block a task gets while it is still on screen. A file
 * read back whole is the ordinary case, and left alone it takes the viewport
 * with it: the answer scrolls off the top before anyone can read it. So the
 * head is kept, the rest is counted, and unfolding the block hands it back.
 */
const MAX_BLOCK_LINES = 12;

interface ToolState {
  title: string;
  locations: string[];
  status: ToolCallStatus;
  content: ToolCallContent[];
  /** What handsfree did about this call — approvals and the writes that landed. */
  notes: ViewLine[];
}

export interface ViewOptions {
  /** Expand or collapse all tasks and tool results; omitted previews running tools and folds finished ones. */
  expanded?: boolean;
  /** Reveal a task's conversation with tool results folded by default. */
  expandedTasks?: ReadonlySet<number>;
  /** Individual choices override the global setting. */
  folds?: ReadonlyMap<string, boolean>;
  /** How a reader gets the folded rows back, if there is a way. */
  expandHint?: string;
  collapseHint?: string;
}

/**
 * The transcript rendered for a human. Nothing here reaches for state of its
 * own: the same records replayed later produce the same view, which is why the
 * TUI, `run`, and any test can share this function.
 *
 * Everything an agent sends over ACP is already in the transcript verbatim, so
 * this is the only place that decides what a person sees — thoughts, tool
 * output, diffs and plans included, not just the prose at the end.
 *
 * A delegated task is drawn as the conversation it is: the agent's rows follow
 * the person's line at the margin, wearing the agent's name, and what the
 * agent last said is the answer — kept whole when the task folds, and never
 * capped while it streams. The rest of the task is watched while it runs and
 * folded once it ends: the brief, where the planner wrote one of its own
 * (a brief that only says the person's line again is never drawn), the tool
 * calls, and whatever the agent said before its answer. A refusal never
 * folds, because that is the one thing the answer cannot make up for. While
 * the task runs, those earlier blocks are capped at their heads — what an
 * agent hands back is often a whole file, and one of those is the whole
 * screen — and unfolding the task lifts both. What the agent said for the
 * planner's benefit, the REPORT block at the end of its turn, is never drawn.
 */
export function buildView(
  records: readonly TranscriptRecord[],
  workspaceDir: string,
  options: ViewOptions = {},
): ViewItem[] {
  const items: ViewItem[] = [];
  const byKey = new Map<string, ViewItem>();
  const tools = new Map<string, ToolState>();

  // Streamed chunks arrive as many records but read as one block, so the block
  // stays open until something else interrupts it.
  let openText: ViewItem | undefined;
  let openThought: ViewItem | undefined;
  // Handsfree's own reply while it streams. The closing assistant record that
  // shares its stream id settles the block's final text — or removes it, when
  // an empty text says what streamed was not an answer after all.
  let openAssistant: { stream: number; item: ViewItem } | undefined;

  // The tool call the machinery is currently talking about. One write produces a
  // tool call, an approval at each gate it passes, and a note saying it landed;
  // as separate rows that is four lines for one file, so the routine ones are
  // folded under the call they belong to. Refusals never fold.
  let openTool: { state: ToolState; item: ViewItem } | undefined;

  // Everything between a delegation and its stop belongs to the agent.
  let currentTask: number | undefined;
  let currentAgent: string | undefined;
  let taskStartedAt = 0;
  let taskTools = 0;
  // Where the current task's rows begin, and which of them survive folding.
  let taskStart = -1;
  const loud = new Set<string>();
  // The line the person last typed, for telling a brief that repeats it.
  let lastUser = '';
  // The latest block of each task's own words: what the agent has answered so
  // far, and what stands as the answer once the task ends.
  const answers = new Map<number, string>();
  // The tasks whose answer is on screen, so the ledger has nothing to add.
  const answered = new Set<string>();
  // What the orchestrator's calls have cost since its last reply, so the
  // reply can close on the figure the way a task's closing line does.
  let planned = { tokens: 0, estimated: false };
  const spent = (item: ViewItem) => {
    if (planned.tokens > 0) {
      item.lines.push({
        text: `${planned.estimated ? '≈' : ''}${shortTokens(planned.tokens)} tokens`,
        tone: 'muted',
      });
    }
    planned = { tokens: 0, estimated: false };
  };

  /** Whether a task's conversation is visible; tool results have their own state. */
  const unfolded = (taskId: number): boolean =>
    options.folds?.get(`task:${taskId}`) ??
    (options.expanded === true || options.expandedTasks?.has(taskId) === true);

  const add = (item: ViewItem): ViewItem => {
    if (currentTask !== undefined) {
      item.taskId = currentTask;
      item.agentId ??= currentAgent;
      // The agent's own rows say whose they are, and the task's first row
      // stands a line off the person's.
      if (item.role === 'agent' && (item.marker === 'bullet' || item.marker === 'tool')) item.label ??= currentAgent;
      if (items.length === taskStart) item.gap = true;
    }
    items.push(item);
    byKey.set(item.key, item);
    return item;
  };
  const closeBlocks = () => {
    openText = undefined;
    openThought = undefined;
    openAssistant = undefined;
  };
  const closeTool = () => {
    openTool = undefined;
  };
  /** Files a routine remark under the tool call it describes. */
  const fold = (line: ViewLine): boolean => {
    if (!openTool) return false;
    openTool.state.notes.push(line);
    openTool.item.lines = toolLines(openTool.state, workspaceDir);
    return true;
  };

  for (const record of records) {
    switch (record.type) {
      case 'user':
        closeBlocks();
        closeTool();
        // A turn that never got to reply leaves its spend unaccounted rather
        // than hung on the next turn's answer.
        planned = { tokens: 0, estimated: false };
        lastUser = record.text;
        add(
          row(
            `u${record.seq}`,
            'user',
            0,
            'prompt',
            'muted',
            record.shown ?? record.text,
            'normal',
            true,
          ),
        );
        break;

      case 'assistant': {
        closeTool();
        const streamed =
          record.stream !== undefined && openAssistant?.stream === record.stream
            ? openAssistant.item
            : undefined;
        closeBlocks();
        if (streamed && (record.text === '' || record.ledger)) {
          // Retracted, or replaced by the ledger: what streamed was not the
          // answer after all, so the block goes — and the ledger, if that is
          // what stands in, is drawn below the way an unstreamed one is.
          const at = items.indexOf(streamed);
          if (at !== -1) items.splice(at, 1);
          byKey.delete(streamed.key);
          if (!record.ledger) break;
        } else if (streamed) {
          streamed.text = record.text;
          spent(streamed);
          break;
        }
        // A retraction whose block is already gone has nothing left to say.
        if (record.stream !== undefined && record.text === '') break;
        if (record.ledger) {
          // Not handsfree's words but the agents': the ledger is each task's
          // head and the agent's own summary, so the row wears the agent's
          // colour, and its name once, in the label rather than in every head.
          let last: ViewItem | undefined;
          for (const entry of ledgerEntries(record.text)) {
            // The answer is on screen already; a head over it says less.
            if (answered.has(entry.taskId)) continue;
            last = add(
              proseRow(`a${record.seq}-${entry.taskId}`, 'handsfree', 0, 'bullet', 'brand', entry.text, 'normal', true),
            );
            if (entry.agentId) {
              last.agentId = entry.agentId;
              last.label = entry.agentId;
            }
          }
          // The planner may have spent something before the ledger stood in
          // for it, and that goes under the ledger's last line.
          if (last) spent(last);
          break;
        }
        spent(add(proseRow(`a${record.seq}`, 'handsfree', 0, 'bullet', 'brand', record.text, 'normal', true)));
        break;
      }

      case 'assistant_delta':
        closeTool();
        openText = undefined;
        openThought = undefined;
        if (openAssistant?.stream === record.stream) {
          openAssistant.item.text += record.text;
        } else {
          openAssistant = {
            stream: record.stream,
            item: add(
              proseRow(`a${record.seq}`, 'handsfree', 0, 'bullet', 'brand', record.text, 'normal', true),
            ),
          };
        }
        break;

      case 'delegation': {
        closeBlocks();
        closeTool();
        currentTask = record.taskId;
        currentAgent = record.agentId;
        taskStartedAt = record.at;
        taskTools = 0;
        taskStart = items.length;
        // The brief, where the planner wrote one of its own, opens the task
        // the way the person's line reads — the agent where the @ would be,
        // the task after it — and folds with the work. A brief that is the
        // person's own line gets no row: the agent's rows follow the line.
        // A title the planner gave the task heads the row, the brief under it.
        if (!asked(lastUser, record.task)) {
          const text = record.title ? `${record.title}\n${record.task}` : record.task;
          const item = add(row(`d${record.seq}`, 'system', 0, 'bullet', 'brand', text, 'normal', true));
          // The label spells the routing the way it was asked for: the
          // agent, and the model when the task chose one — by the id it was
          // switched by, which is the id the mention typed and the id that
          // went on the wire.
          item.label = modelled(record.agentId, record);
        }
        break;
      }

      case 'note': {
        closeBlocks();
        const detail = record.lines ?? [];
        // A note that brought its own lines is not a routine remark about a
        // tool call, and folding it into one would drop the lines entirely.
        if (record.level === 'info' && detail.length === 0 && fold({ text: record.text, tone: 'muted' })) {
          break;
        }
        closeTool();
        if (record.level !== 'info') loud.add(`n${record.seq}`);
        // An error or a warning is news, and stands as its own row: a dot in
        // its colour, and a line off whatever came before — a remark hung
        // under a task's closing line read as part of that task.
        const tone: Tone = record.level === 'error' ? 'bad' : record.level === 'warn' ? 'warn' : 'muted';
        const news = record.level !== 'info';
        const note = add(
          row(
            `n${record.seq}`,
            'system',
            0,
            news ? 'bullet' : 'none',
            news ? tone : 'muted',
            record.text,
            tone,
            news || detail.length > 0,
          ),
        );
        note.lines = detail.map((text) => ({ text, tone: 'muted' as const }));
        break;
      }

      case 'decision': {
        closeBlocks();
        const allowed = record.entry.verdict === 'allow';
        // A yes the mode gave says so, since the rules on their own would
        // have asked or refused — a reader of the record should not have
        // to wonder who let this one through.
        const via = record.entry.mode ? ` (${MODE_LABEL[record.entry.mode]})` : '';
        if (allowed && fold({ text: `✓ ${record.entry.summary}${via}`, tone: 'muted' })) break;
        closeTool();
        const why = record.entry.reason ? ` — ${record.entry.reason}` : '';
        if (!allowed) loud.add(`p${record.seq}`);
        add(
          row(
            `p${record.seq}`,
            'system',
            0,
            allowed ? 'allowed' : 'refused',
            allowed ? 'muted' : 'bad',
            `${record.entry.summary}${allowed ? via : why}`,
            allowed ? 'muted' : 'bad',
            false,
          ),
        );
        break;
      }

      case 'stop': {
        closeBlocks();
        closeTool();
        const took = taskStartedAt > 0 ? Math.max(1, Math.round((record.at - taskStartedAt) / 1000)) : 0;
        // What the agent last said is the answer, and stays when the rest
        // folds. A task that did not finish keeps the ledger's account
        // instead: the words it got out are not the whole story, and the
        // head says what became of it.
        const answer = answers.get(record.taskId);
        if (record.stopReason === 'end_turn' && answer !== undefined && byKey.has(answer)) {
          loud.add(answer);
          answered.add(String(record.taskId));
        }
        const foldable = foldableRows(items, loud, taskStart);
        const hidden = unfolded(record.taskId) ? 0 : foldTask(items, byKey, loud, taskStart);
        // The closing line belongs to the task, so it keeps the task's indent
        // and its id; whatever comes next is handsfree talking again.
        add(
          row(
            `s${record.seq}`,
            'system',
            0,
            'result',
            'muted',
            stopText(
              record.status && record.status !== 'done' ? record.status : record.stopReason,
              taskTools,
              took,
              record.usage ? tokensOf(record.usage) : 0,
              hidden > 0 ? options.expandHint : foldable > 0 ? options.collapseHint : undefined,
            ),
            record.stopReason === 'end_turn' ? 'muted' : 'warn',
            false,
          ),
        );
        // A task with nothing to fold has nothing for a click to do, so its
        // rows are nobody's to hover or open: the hover would only promise a
        // click that changes nothing.
        if (foldable === 0) {
          for (const item of items.slice(taskStart)) item.taskId = undefined;
        } else {
          for (const item of items.slice(taskStart)) {
            item.fold = { id: `task:${record.taskId}`, expanded: unfolded(record.taskId) };
          }
        }
        currentTask = undefined;
        currentAgent = undefined;
        taskStart = -1;
        break;
      }

      case 'clear':
        // The screen starts over; the run does not. A task still in flight
        // keeps its id and its agent, so the rows it goes on to
        // send are still its own and its closing line still folds them — from
        // the top of the emptied list, which is where the task now begins.
        // What the tool calls know about themselves is kept for the same
        // reason: an update to a call from before the clear draws its row
        // again complete, rather than as a bare id nobody can read.
        items.length = 0;
        byKey.clear();
        loud.clear();
        closeBlocks();
        closeTool();
        taskStart = currentTask !== undefined ? 0 : -1;
        break;

      // Where each agent's session came from is the header's to say, not a
      // row in the conversation: nothing was asked and nothing was answered.
      case 'session':
        break;

      case 'agent_stderr':
        break; // Kept in the file, not shown: adapters are chatty on stderr.

      // The orchestrator's own calls, added up for the reply that closes them.
      // A task's usage record is about characters relayed, not tokens spent.
      case 'usage':
        if (record.purpose === 'task') break;
        if (record.promptTokens !== undefined) {
          planned.tokens += record.promptTokens + (record.completionTokens ?? 0);
        } else {
          planned.tokens += Math.ceil(record.promptChars / 4) + Math.ceil(record.replyChars / 4);
          planned.estimated = true;
        }
        break;

      case 'session_update': {
        const update = record.update;
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            if (update.content.type !== 'text') break;
            openThought = undefined;
            closeTool();
            if (openText) openText.text += update.content.text;
            else {
              openText = add(
                proseRow(`m${record.seq}`, 'agent', 0, 'bullet', 'brand', update.content.text, 'normal', true),
              );
              if (currentTask !== undefined) answers.set(currentTask, openText.key);
            }
            break;
          }

          case 'agent_thought_chunk': {
            if (update.content.type !== 'text') break;
            openText = undefined;
            closeTool();
            if (openThought) openThought.text += update.content.text;
            else {
              openThought = add(
                proseRow(`h${record.seq}`, 'agent', 0, 'thought', 'muted', update.content.text, 'muted', true),
              );
            }
            break;
          }

          case 'tool_call':
          case 'tool_call_update': {
            closeBlocks();
            const key = `tool:${record.agentId}:${record.sessionId}:${currentTask ?? ''}:${update.toolCallId}`;
            const state = tools.get(key) ?? {
              title: update.toolCallId,
              locations: [],
              status: 'pending' as ToolCallStatus,
              content: [],
              notes: [],
            };
            if (update.title) state.title = update.title;
            if (update.status) state.status = update.status;
            if (update.locations) {
              state.locations = update.locations.map((location) => location.path).filter(Boolean);
            }
            if (update.content) state.content = update.content;
            tools.set(key, state);

            const existing = byKey.get(key);
            const target =
              existing ?? add(row(key, 'agent', 1, 'tool', 'muted', '', 'muted', false));
            if (!existing) taskTools++;
            target.text = headline(state, workspaceDir);
            target.tone = state.status === 'failed' ? 'bad' : 'muted';
            target.markerTone = statusTone(state.status);
            target.lines = toolLines(state, workspaceDir);
            openTool = { state, item: target };
            break;
          }

          case 'plan':
          case 'plan_update': {
            closeBlocks();
            closeTool();
            const entries = planEntries(update);
            const planId =
              update.sessionUpdate === 'plan_update' && 'planId' in update.plan
                ? update.plan.planId
                : 'plan';
            const key = `l${record.agentId}:${planId}`;

            if (!entries) {
              // A markdown or file-backed plan carries no checklist to draw.
              const text = update.sessionUpdate === 'plan_update' && update.plan.type === 'markdown'
                ? update.plan.content
                : 'Plan updated';
              const item = byKey.get(key) ?? add(row(key, 'agent', 0, 'bullet', 'accent', '', 'muted', true));
              item.text = clip(text, MAX_LINE_CHARS);
              break;
            }

            const item = byKey.get(key) ?? add(row(key, 'agent', 0, 'bullet', 'accent', '', 'normal', true));
            const done = entries.filter((entry) => entry.status === 'completed').length;
            item.text = `Plan (${done}/${entries.length})`;
            item.lines = entries.map(planLine);
            break;
          }

          case 'current_mode_update': {
            closeBlocks();
            add(
              row(
                `c${record.seq}`,
                'agent',
                0,
                'none',
                'muted',
                `mode: ${update.currentModeId}`,
                'muted',
                false,
              ),
            );
            break;
          }

          default:
            break;
        }
        break;
      }
    }
  }

  // Decide folding after streaming has settled. Tool results own their click
  // target, including short results and results outside a delegation. The
  // latest answer stays whole; older prose still follows its task's cap.
  for (const item of items) {
    if (item.role === 'agent' && item.prose === true) item.text = stripReport(item.text);
    item.text = item.text.trim();
    const tool = tools.get(item.key);
    if (tool) {
      item.fold = undefined;
      const full = toolLines(tool, workspaceDir);
      if (full.length === 0) continue;
      const detailCount = full.length - tool.notes.length;
      const choice = options.folds?.get(item.key) ?? options.expanded ??
        (item.taskId !== undefined && unfolded(item.taskId) ? false : undefined) ??
        (tool.status === 'completed' || tool.status === 'failed' ? false : undefined);
      item.lines = choice === false
        ? [more(full.length, options.expandHint)]
        : choice === true || detailCount <= MAX_BLOCK_LINES ? full
        : [...full.slice(0, MAX_BLOCK_LINES), more(detailCount - MAX_BLOCK_LINES, options.expandHint), ...tool.notes];
      const expanded = choice !== false && (choice === true || detailCount <= MAX_BLOCK_LINES);
      item.fold = { id: item.key, expanded };
      if (expanded && options.collapseHint) {
        item.lines.push({ text: options.collapseHint, tone: 'muted' });
      }
      continue;
    }
    if (item.taskId === undefined || answers.get(item.taskId) === item.key) continue;
    if (item.prose === true && item.text.split('\n').length > MAX_BLOCK_LINES) {
      const expanded = unfolded(item.taskId);
      item.fold ??= { id: `task:${item.taskId}`, expanded };
      if (!expanded) capText(item, options.expandHint);
      else if (options.collapseHint) item.lines.push({ text: options.collapseHint, tone: 'muted' });
    }
  }
  // A block that was nothing but its REPORT has nothing left to draw.
  return items.filter((item) => !(item.role === 'agent' && item.prose === true && item.text === ''));
}

/**
 * Whether a brief is the person's own line said again: an @mention passes the
 * words after the name on as typed, and a planner sometimes does the same.
 */
function asked(user: string, task: string): boolean {
  const said = user.replace(/^\s*@\S+/, '').replace(/\s+/g, ' ').trim();
  return said !== '' && said === task.replace(/\s+/g, ' ').trim();
}

/** A row carrying an agent's own words, which the renderer draws as markdown. */
function proseRow(...args: Parameters<typeof row>): ViewItem {
  const item = row(...args);
  item.prose = true;
  return item;
}

function row(
  key: string,
  role: ViewItem['role'],
  depth: number,
  marker: Marker,
  markerTone: Tone,
  text: string,
  tone: Tone,
  gap: boolean,
): ViewItem {
  return { key, role, depth, marker, markerTone, text, tone, lines: [], gap };
}

/** How many of a task's rows folding would take off screen. */
function foldableRows(items: readonly ViewItem[], loud: Set<string>, from: number): number {
  if (from < 0 || from >= items.length) return 0;
  return items.slice(from).filter((item) => !loud.has(item.key)).length;
}

/**
 * Drops the rows a finished task no longer needs to keep on screen, in place.
 * Returns how many went, so the closing line can offer them back.
 */
function foldTask(
  items: ViewItem[],
  byKey: Map<string, ViewItem>,
  loud: Set<string>,
  from: number,
): number {
  if (from < 0 || from >= items.length) return 0;
  const kept: ViewItem[] = [];
  let hidden = 0;
  for (const item of items.slice(from)) {
    if (loud.has(item.key)) {
      kept.push(item);
      continue;
    }
    byKey.delete(item.key);
    hidden++;
  }
  items.length = from;
  items.push(...kept);
  return hidden;
}

function statusTone(status: ToolCallStatus): Tone {
  switch (status) {
    case 'failed':
      return 'bad';
    case 'completed':
      return 'good';
    default:
      return 'warn';
  }
}

/**
 * The closing line's account of the task: what it took in tool calls, in
 * seconds, and in tokens where the agent counted them — a turn nobody
 * counted says nothing about tokens rather than a zero that would be false.
 */
function stopText(
  reason: StopReason | 'unresponsive' | 'blocked' | 'incomplete' | 'refused' | 'error' | 'budget_exceeded',
  toolCount: number,
  seconds: number,
  tokens: number,
  expandHint: string | undefined,
): string {
  const cost = [
    toolCount > 0 ? `${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}` : undefined,
    seconds > 0 ? `${seconds}s` : undefined,
    tokens > 0 ? `${shortTokens(tokens)} tokens` : undefined,
    expandHint,
  ].filter(Boolean);
  const suffix = cost.length > 0 ? ` (${cost.join(' · ')})` : '';
  switch (reason) {
    case 'end_turn':
      return `Done${suffix}`;
    case 'cancelled':
      return `Cancelled${suffix}`;
    case 'refusal':
      return `Refused by the agent${suffix}`;
    default:
      return `Stopped: ${reason}${suffix}`;
  }
}

function planLine(entry: PlanEntry): ViewLine {
  switch (entry.status) {
    case 'completed':
      return { text: `☒ ${entry.content}`, tone: 'muted' };
    case 'in_progress':
      return { text: `☐ ${entry.content}`, tone: 'accent' };
    default:
      return { text: `☐ ${entry.content}`, tone: 'normal' };
  }
}

/** The tool call's one-line title, with workspace paths cut down to size. */
function headline(state: ToolState, root: string): string {
  const title = shorten(state.title, root);
  const named = state.locations
    .map((file) => relative(file, root))
    .filter((file) => !title.includes(file));
  return named.length > 0 ? `${title} (${named.join(', ')})` : title;
}

/**
 * Everything shown under one tool call: what it produced, then what handsfree
 * did about it. Previewing and folding are applied once the row is complete.
 */
function toolLines(
  state: ToolState,
  root: string,
): ViewLine[] {
  return [...detailLines(state.content, root), ...state.notes];
}

/**
 * Trims an agent's own words down to their head. The count goes under the
 * block on the same gutter a tool call's output uses, so a capped answer and a
 * capped file read look alike — one thing was left out, and here is how much.
 */
function capText(item: ViewItem, hint: string | undefined): void {
  const lines = item.text.split('\n');
  if (lines.length <= MAX_BLOCK_LINES) return;
  item.text = lines.slice(0, MAX_BLOCK_LINES).join('\n').trimEnd();
  item.lines = [...item.lines, more(lines.length - MAX_BLOCK_LINES, hint)];
}

/** What stands in for the lines a cap left out, and how to get them back. */
function more(hidden: number, hint: string | undefined): ViewLine {
  const how = hint ? ` (${hint})` : '';
  return { text: `… +${hidden} ${hidden === 1 ? 'line' : 'lines'}${how}`, tone: 'muted' };
}

/**
 * What the tool itself produced. This is the part the protocol gives us for
 * free and the part a host most easily throws away: without it a tool call is
 * a title and nothing else.
 */
function detailLines(content: readonly ToolCallContent[], root: string): ViewLine[] {
  const lines: ViewLine[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'content':
        lines.push(...blockLines(part.content));
        break;
      case 'diff':
        lines.push(...diffLines(part, root));
        break;
      case 'terminal':
        lines.push({ text: `terminal ${part.terminalId}`, tone: 'muted' });
        break;
    }
  }
  // Whole, blank ends aside: what a running task shows of this is the caller's
  // to decide, and a task unfolded on purpose is asking for all of it.
  return trimBlank(lines);
}

function blockLines(block: ContentBlock): ViewLine[] {
  switch (block.type) {
    case 'text':
      return block.text
        .split('\n')
        .map((text) => ({ text: clip(text, Infinity), tone: 'muted' as Tone }));
    case 'image':
      return [{ text: '[image]', tone: 'muted' }];
    case 'audio':
      return [{ text: '[audio]', tone: 'muted' }];
    case 'resource_link':
      return [{ text: block.name || block.uri, tone: 'muted' }];
    case 'resource':
      return [{ text: block.resource.uri, tone: 'muted' }];
  }
}

/**
 * A whole-file before/after is what ACP hands us, so the change is recovered by
 * trimming the parts that did not move. It is not a real diff — it is enough to
 * show what an edit did without reprinting the file.
 */
function diffLines(diff: Diff, root: string): ViewLine[] {
  const before = diff.oldText ? diff.oldText.split('\n') : [];
  const after = diff.newText.split('\n');

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  const where = relative(diff.path, root);
  const summary =
    before.length === 0
      ? `Wrote ${where} (${added.length} ${added.length === 1 ? 'line' : 'lines'})`
      : `Updated ${where} (+${added.length} −${removed.length})`;

  return [
    { text: summary, tone: 'muted' },
    ...removed.map((text) => ({ text: clip(`- ${text}`, Infinity), tone: 'bad' as Tone })),
    ...added.map((text) => ({ text: clip(`+ ${text}`, Infinity), tone: 'good' as Tone })),
  ];
}

function trimBlank(lines: ViewLine[]): ViewLine[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.text.trim() === '') end--;
  let start = 0;
  while (start < end && lines[start]!.text.trim() === '') start++;
  return lines.slice(start, end);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\t/g, '  ').replace(/\r/g, '');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The checklist a plan update carries, where it carries one at all. */
function planEntries(update: SessionUpdate): readonly PlanEntry[] | undefined {
  if (update.sessionUpdate === 'plan') return update.entries;
  if (update.sessionUpdate === 'plan_update' && update.plan.type === 'items') {
    return update.plan.entries;
  }
  return undefined;
}

/**
 * Where a running turn stands. Three beats is all a glance wants, and all the
 * transcript can honestly tell apart.
 */
export type TurnPhase = 'start' | 'work' | 'nearly';

/** What the mark briefs: where the turn stands, or that it is over. */
export type Brief = TurnPhase | 'done';

/** How much of a plan has to be ticked off before the end is in sight. */
const NEARLY = 2 / 3;

/**
 * How far the running turn has got, read off the transcript rather than off
 * the clock — a turn is done when the work is, not when a timer says so.
 * Nothing delegated yet is the start; a task still open is the work itself,
 * and the plan the agent keeps beside it, where it keeps one, is what says
 * the end is in sight; every task stopped leaves only handsfree's own
 * write-up, which is as near done as this can claim while a turn still runs.
 *
 * Only the records since the last prompt count — the phase is about this
 * turn — and the newest plan is the one read, whichever agent posted it: the
 * checklist on screen is the one a briefing has to agree with.
 */
export function turnPhase(records: readonly TranscriptRecord[]): TurnPhase {
  const turn = records.slice(records.findLastIndex((record) => record.type === 'user') + 1);
  const open = new Set<number>();
  let delegated = 0;
  let plan: readonly PlanEntry[] | undefined;
  for (const record of turn) {
    if (record.type === 'delegation') {
      delegated++;
      open.add(record.taskId);
    } else if (record.type === 'stop') open.delete(record.taskId);
    else if (record.type === 'session_update') plan = planEntries(record.update) ?? plan;
  }
  if (delegated === 0) return 'start';
  if (open.size === 0) return 'nearly';
  if (!plan?.length) return 'work';
  const done = plan.filter((entry) => entry.status === 'completed').length;
  return done >= plan.length * NEARLY ? 'nearly' : 'work';
}

/**
 * The agents with a task open right now: a delegation seen, its stop not yet.
 * Replayed from the transcript rather than kept as state of its own, for the
 * same reason the view is — the records already say who is working.
 */
export function workingAgents(records: readonly TranscriptRecord[]): ReadonlySet<string> {
  const open = new Map<number, string>();
  for (const record of records) {
    if (record.type === 'delegation') open.set(record.taskId, record.agentId);
    else if (record.type === 'stop') open.delete(record.taskId);
  }
  return new Set(open.values());
}

/** An agent as a task names it: `agent`, or `agent:model` where one was chosen. */
function modelled(agentId: string, record: { model?: string }): string {
  return record.model ? `${agentId}:${record.model}` : agentId;
}

/** One-line rendering for non-interactive output. Returns nothing for noise. */
export function describeRecord(record: TranscriptRecord, workspaceDir: string): string | undefined {
  switch (record.type) {
    case 'user':
      return `> ${record.text}`;
    case 'assistant':
      // An empty text retracts a streamed block; there is nothing to print.
      return record.text === '' ? undefined : `\n${record.text}\n`;
    case 'delegation':
      return `→ ${modelled(record.agentId, record)}: ${record.title ?? record.task}`;
    case 'note':
      return [record.text, ...(record.lines ?? [])].map((line) => `  ${line}`).join('\n');
    case 'decision':
      return (
        `  ${record.entry.verdict === 'allow' ? '+' : '-'} ${record.entry.summary}` +
        (record.entry.mode ? ` (${record.entry.mode})` : '')
      );
    case 'stop':
      return `← ${record.agentId} (${record.stopReason}${
        record.usage ? `, ${shortTokens(tokensOf(record.usage))} tokens` : ''
      })`;
    case 'session':
      // A fresh session is the ordinary case and says nothing; a resumed one
      // is worth a line, since the agent remembers things this run did not do.
      return record.how === 'resumed' ? `  resumed ${record.agentId} session ${record.sessionId}` : undefined;
    case 'session_update': {
      const update = record.update;
      if (update.sessionUpdate === 'tool_call') {
        const where = (update.locations ?? [])
          .map((location) => relative(location.path, workspaceDir))
          .join(', ');
        return `  · ${update.title}${where ? ` [${where}]` : ''}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The head of a task in a ledger, as `renderOutcomeHead` writes it. */
const LEDGER_HEAD = /^Task (\d+) \((\S+)\): (.*)$/;

/**
 * A ledger reply split into the tasks it lists: each head and the lines under
 * it, with the agent's name lifted out of the head — it goes in the label —
 * and anything that is not a task (a note about the turn) on its own.
 */
export function ledgerEntries(text: string): { taskId: string; agentId?: string; text: string }[] {
  const entries: { taskId: string; agentId?: string; text: string }[] = [];
  let unnumbered = 0;
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n');
    const head = LEDGER_HEAD.exec(lines[0] ?? '');
    if (head) {
      entries.push({
        taskId: head[1]!,
        agentId: head[2]!,
        text: [`task ${head[1]}: ${head[3]}`, ...lines.slice(1)].join('\n'),
      });
    } else if (block.trim() !== '') {
      entries.push({ taskId: `n${++unnumbered}`, text: block });
    }
  }
  return entries;
}

/**
 * How each agent's session came to be, as the record has it — the latest
 * word on each, since a session replaced mid-run is a new one.
 */
export function sessionsOf(records: readonly TranscriptRecord[]): Record<string, 'new' | 'resumed'> {
  const out: Record<string, 'new' | 'resumed'> = {};
  for (const record of records) {
    if (record.type === 'session') out[record.agentId] = record.how;
  }
  return out;
}

function relative(file: string, root: string): string {
  const rel = path.relative(root, file);
  return rel === '' || rel.startsWith('..') ? file : rel;
}

/** Workspace paths anywhere in a sentence, cut down to what a reader needs. */
function shorten(text: string, root: string): string {
  if (!root) return text;
  return text.split(`${root}/`).join('').split(root).join('.');
}
