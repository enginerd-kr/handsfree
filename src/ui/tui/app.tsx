import os from 'node:os';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, Transform, useApp, useInput, useStdout } from 'ink';
import type { Runtime } from '../../runtime.js';
import type { InputAnswer, InputField, InputValue } from '../../policy/types.js';
import { debugDestination } from '../../debug.js';
import {
  buildView,
  turnPhase,
  workingAgents,
  type Brief,
  type Tone,
  type TurnPhase,
  type ViewItem,
  sessionsOf,
  type ViewLine,
} from '../view-model.js';
import type { ModelChoice } from '../../host/models.js';
import { agentRole, orchestrationModel, type Config } from '../../config/schema.js';
import {
  findCommand,
  parseSlashCommand,
  suggest,
  takesArguments,
  type Command,
} from '../../slash/command.js';
import {
  completeMention,
  completeModel,
  mentionSpans,
  modelTokenAt,
  ORCHESTRATOR,
  plannerTokenAt,
  suggestAgents,
  suggestModels,
} from '../../mention/mention.js';
import { copyToClipboard } from './clipboard.js';
import { NOTHING_SENT, recall, remember, settle, type History } from './history.js';
import {
  DETAIL_INDENT,
  GUTTER,
  itemAt,
  itemRows,
  placeItems,
  totalHeight,
  visualRows,
  windowAt,
} from './layout.js';
import { type Highlighter, loadHighlighter, renderMarkdown } from './markdown.js';
import { CURSOR_QUERY, isMouseReport, parseCursorReport, parseMouseEvent, trackMouse } from './mouse.js';
import { type Bounds, highlightFor, order, type Point, selectedText } from './selection.js';
import {
  agentColour,
  BAND,
  BRAND,
  BRIEFINGS,
  COLOUR,
  columns,
  DOT_BUSY,
  DOT_IDLE,
  GLYPH,
  HOVER_BAND,
  INK,
  INK_FAINT,
  type Look,
  MASCOT,
  MASCOT_STAGE,
  mascot,
  PLAN_BUSY,
  PLAN_IDLE,
  type Stance,
  PROMPT_BAND,
  SAYINGS,
  stage,
  PROMPT_CHAR,
  RESULT_GUTTER,
  RESULT_INDENT,
  RULE_INK,
  SHIMMER,
  SHIMMER_STEP_MS,
  shimmer,
  SPINNER,
} from './theme.js';
import { VERSION } from '../../version.js';

const EXPAND_HINT = 'click or ctrl+o to expand';

/**
 * The blink: how long the eyes stay shut, the range the beat between the two
 * halves of a double blink is drawn from, and the range of the long wait
 * between blinks. Nothing here is a fixed number — a mark that blinks on a
 * metronome reads as a progress indicator rather than as something alive.
 */
const BLINK_SHUT_MS = 140;
const BLINK_AGAIN_MS = [140, 1000] as const;
const BLINK_WAIT_MS = [4000, 6500] as const;

/** A millisecond count drawn from one of the ranges above. */
function between([low, high]: readonly [number, number]): number {
  return low + Math.random() * (high - low);
}

/**
 * The wander: the gait per column, the range of a pause wherever the walk
 * ends, the range of the breather at home between outings — with a shorter
 * one before the very first, so the mark reads as alive from the opening
 * frame — and how long a saying hangs in the air. The gait itself is steady;
 * it is what the mark does next that stays unpredictable, for the same
 * reason the blink's waits are ranges.
 */
const WANDER_STEP_MS = 90;
const WANDER_PAUSE_MS = [1200, 3500] as const;
const WANDER_HOME_MS = [6000, 14000] as const;
/**
 * The breather while a turn is running. Shorter than the idle one, because
 * the mark has something to say now and a briefing that lands a quarter of a
 * minute after the phase turned is a report on the past.
 */
const WANDER_BRIEF_MS = [1500, 4000] as const;
const WANDER_OPEN_MS = [1500, 3500] as const;
const SAY_MS = [1800, 3200] as const;

/**
 * How long the mark keeps the sign-off to hand after a turn ends — one
 * breather and one outing over, so the word actually goes out, and not so
 * long that the mark is still reporting a turn nobody remembers.
 */
const SIGN_OFF_MS = 12000;

/**
 * The poses: how long a sit on the ground lasts, how long the mark stands at
 * ease with its arms dropped, and the three beats of a jump — the dip, the
 * hang in the air, and the landing before anything else happens. The jump's
 * beats are fixed because a jump has a rhythm; the holds are ranges for the
 * same reason the blink's waits are.
 */
const SIT_MS = [4000, 9000] as const;
const EASY_MS = [2000, 4500] as const;
const JUMP_DIP_MS = 160;
const JUMP_AIR_MS = 260;
const JUMP_LAND_MS = 420;

/** How many columns a clean exit takes: every cell of the mark, edge to edge. */
const WANDER_SPAN = [...MASCOT[0]].length;

/** The rightmost column the mark may drift to and still fit on its stage. */
const WANDER_ROAM = MASCOT_STAGE - WANDER_SPAN;

/** Where the mark belongs when nothing is happening: the middle of its stage. */
const WANDER_HOME = Math.round(WANDER_ROAM / 2);

/**
 * Rows above the transcript: the welcome mark's three rows and the blank row
 * on either side of it. The mark never wraps, so this stays a constant a
 * click's row can be measured against.
 */
const HEADER_ROWS = 5;

/**
 * How many suggestions a slash or an at-sign menu offers before it starts
 * crowding the transcript. What a short window can actually spare still wins
 * over this number.
 */
const MENU_ROWS = 10;

/**
 * How much transcript a menu has to leave standing. Eight rows for a slash or
 * an at-sign, whose lists are long by nature and narrow as the name is typed —
 * a cut there is expected and recoverable. A colon's is held to four: a model
 * list is what the profile declares, all of it, and the row pushed off the
 * bottom is the one you cannot know you did not read. Four rows of transcript
 * for a moment is the cheaper loss.
 */
const MENU_FLOOR = 8;
const MODEL_FLOOR = 4;

/**
 * Rows below it: the status line, the prompt's two rules with its input between
 * them, and the hint. The status line is always drawn — blank when nothing is
 * running — so the transcript's budget never changes as a turn starts.
 */
const PROMPT_ROWS = 5;

/**
 * How far one turn of the wheel moves the transcript. Three rows is what a
 * terminal sends per notch when it scrolls itself, so the frame moves at the
 * speed the hand expects.
 */
const WHEEL_ROWS = 3;

/**
 * The pace the owed scroll is paid out at. A flick of the wheel arrives as a
 * burst of reports — often several fused into one stdin chunk — and paying
 * them all in one render is the lurch the eye reads as jank. They pool
 * instead, and every DRAIN_MS a frame takes three quarters of the debt:
 * never fewer than SCROLL_STEP rows, so the tail comes to a stop rather
 * than crawling, and never more than a viewport, which is as far as a jump
 * can be followed. A single notch is under the step and lands whole. This
 * is the shape of Claude Code's own scroll drain, run at React's cadence
 * because a stock Ink render is the only frame there is.
 */
const DRAIN_MS = 16;
const SCROLL_STEP = 4;

/**
 * A question waiting on the person at the keyboard. Both kinds queue in one
 * line and own the screen the same way, because from here they are the same
 * thing: an agent has stopped, and it is stopped until this is answered.
 * `answer` is idempotent — a question that times out while it is being typed
 * into must not also hand the queue its next entry.
 */
type Question =
  | {
      kind: 'ask';
      summary: string;
      detail: string;
      rule: string;
      agentId: string;
      answer: (allowed: boolean) => void;
    }
  | {
      kind: 'input';
      summary: string;
      agentId: string;
      fields: readonly InputField[];
      answer: (answer: InputAnswer) => void;
    };

/** Where a form has got to: which field is being filled, and what is typed. */
interface FormState {
  index: number;
  values: Record<string, InputValue>;
  buffer: string;
  chosen: readonly string[];
  error: string | undefined;
}

/**
 * What is half-written in the prompt. The cursor counts code points, not UTF-16
 * units, so it never lands inside a surrogate pair; value and cursor live in
 * one object because every edit must move both together, even when several
 * keypresses arrive in the same stdin chunk and are handled before a render.
 */
interface Draft {
  value: string;
  cursor: number;
}

/**
 * One row of the menu, whichever list it came from. A slash offers commands
 * and an at-sign offers agents; the two never fire together — a command is
 * still being spelled while the line has no spaces, and by then it holds no
 * word an `@` could open — so one selection, one keymap and one layout serve
 * both.
 */
/**
 * What became of the session opened to learn an agent's models: it answered,
 * or it never opened and said why. Absent means the asking is still in flight.
 */
type RosterState = 'ready' | { failed: string };

type MenuItem =
  | { kind: 'command'; command: Command }
  // `planner` says the name is being filled in behind `@orchestrator:`, where
  // the row on screen is a `:segment` of an address rather than an `@` of its own.
  | { kind: 'agent'; id: string; note: string; planner?: true }
  | { kind: 'model'; agent: string; choice: ModelChoice };

/**
 * How many rows a menu of this kind may take in a window this tall. The frame
 * is a fixed height and one that overflows scrolls the whole UI, so the menu
 * is bounded by what the transcript can spare — MENU_FLOOR for a slash or an
 * at-sign, and MENU_ROWS on top of that, since those lists are long by nature
 * and narrow as the name is typed. A model list gets neither ceiling and the
 * lower floor: it is what the profile declares, all of it, and a list cut
 * short reads as handsfree having an opinion about which models exist.
 */
export function menuFit(kind: MenuItem['kind'], rows: number): number {
  const models = kind === 'model';
  const room = rows - 1 - HEADER_ROWS - PROMPT_ROWS - (models ? MODEL_FLOOR : MENU_FLOOR);
  return Math.max(0, models ? room : Math.min(MENU_ROWS, room));
}

/** What a row is filtered by and measured by: `/name`, `@name` or `:model`. */
function menuLabel(item: MenuItem): string {
  if (item.kind === 'command') return `/${item.command.name}`;
  if (item.kind === 'agent') return item.planner ? `:${item.id}` : `@${item.id}`;
  return `:${item.choice.value}`;
}

export function App({ runtime }: { runtime: Runtime }): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [items, setItems] = useState<ViewItem[]>([]);
  const [draft, setDraft] = useState<Draft>({ value: '', cursor: 0 });
  // The draft's synchronous truth. Keys fused into one stdin chunk are all
  // handled before React re-renders, so a handler that read `draft` would see
  // the value from before any of them; edits go through this ref and state
  // only mirrors it for rendering.
  const draftRef = useRef<Draft>(draft);
  // Which suggestion is highlighted, and what text the menu was waved away
  // for. Both keep a ref for the same reason the draft does: a fused stdin
  // chunk is handled to the end before React re-renders, so a handler reading
  // state would be reading the frame before the one it is in.
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const dismissedRef = useRef<string | undefined>(undefined);
  // What the prompt has sent this run, and how far back through it the arrows
  // have walked. Nothing on screen is drawn from it — the recalled line is put
  // in the draft like any other text — so it is a ref rather than state.
  const historyRef = useRef<History>(NOTHING_SENT);
  const applyDraft = (update: (d: Draft) => Draft) => {
    const next = update(draftRef.current);
    // Every edit aims the menu afresh. A dismissal is keyed by the text it was
    // dismissed for, so it lapses on its own the moment the text moves on.
    if (next.value !== draftRef.current.value) {
      if (selectedRef.current !== 0) {
        selectedRef.current = 0;
        setSelected(0);
      }
      // An edit is a line of its own, whatever it was recalled from: the walk
      // back through what was sent ends here. A step of the walk edits the
      // draft too, and puts its own history back straight afterwards.
      historyRef.current = settle(historyRef.current);
    }
    draftRef.current = next;
    setDraft(next);
  };
  const [startedAt, setStartedAt] = useState<number | undefined>();
  // Typed while a turn was running. The prompt stays open the whole time, so
  // what is entered has to go somewhere; it goes here and leaves in order once
  // the turn that was in the way finishes.
  const [queued, setQueued] = useState<readonly string[]>([]);
  const [ask, setAsk] = useState<Question | undefined>();
  // The form being filled in, when the question on screen is one. It keeps a
  // ref for the reason the draft does: several keys can arrive in one stdin
  // chunk and are all handled before React renders once.
  const [form, setForm] = useState<FormState | undefined>();
  const formRef = useRef<FormState | undefined>(undefined);
  const applyForm = (next: FormState | undefined) => {
    formRef.current = next;
    setForm(next);
  };
  const [openTasks, setOpenTasks] = useState<ReadonlySet<number>>(() => new Set());
  const [hoveredTask, setHoveredTask] = useState<number | undefined>();
  // Who has a task open right now, replayed from the same records the view is.
  const [working, setWorking] = useState<ReadonlySet<string>>(() => new Set());
  // How far the running turn has got, replayed the same way, for the mark to
  // brief. It is read whether or not a turn is running; what a phase means
  // once one has finished is `brief`'s business, not this one's.
  const [phase, setPhase] = useState<TurnPhase>('start');
  const pending = useRef<Question[]>([]);
  /** The question actually on screen, kept in step with `ask` synchronously. */
  const head = useRef<Question | undefined>(undefined);
  const busy = startedAt !== undefined;

  // The mark's last word on a turn. A turn ending leaves no record of its own
  // — the spinner going out is the whole of the news — so the sign-off is
  // held here for long enough that one outing can carry it, and then the mark
  // has nothing to report again.
  const [signedOff, setSignedOff] = useState(false);
  /** Which agents came back on a session from a previous process, for the header. */
  const [sessions, setSessions] = useState<Record<string, 'new' | 'resumed'>>({});
  const ran = useRef(false);
  useEffect(() => {
    if (busy) {
      ran.current = true;
      setSignedOff(false);
      return;
    }
    // Nothing has run yet: the opening frame is not the end of a turn.
    if (!ran.current) return;
    ran.current = false;
    setSignedOff(true);
    const timer = setTimeout(() => setSignedOff(false), SIGN_OFF_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  /** What the mark has to report: the running turn's phase, or that it is over. */
  const brief: Brief | undefined = busy ? phase : signedOff ? 'done' : undefined;

  // A drag in flight: the cell the button went down on, and whether the
  // pointer has moved since. Press and release in place is the click it always
  // was; anything that moved is a selection.
  const dragRef = useRef<{ anchor: Point; moved: boolean } | undefined>(undefined);
  // The selection's two ends, as cells of the transcript — rows counted down
  // the whole transcript rather than down the screen, so the selection keeps
  // holding the characters it grabbed while the transcript scrolls or grows
  // under the drag. The ref mirrors it for the input handler, which can run
  // several times before a render.
  const [selection, setSelection] = useState<{ anchor: Point; focus: Point } | undefined>();
  const selectionRef = useRef(selection);
  const applySelection = (next: { anchor: Point; focus: Point } | undefined) => {
    selectionRef.current = next;
    setSelection(next);
  };
  // How many lines the last drag put on the clipboard, for as long as the hint
  // line says so.
  const [copied, setCopied] = useState<number | undefined>();
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  // Reporting has to be turned back off, or the terminal keeps sending drags
  // here instead of selecting text long after handsfree has exited.
  useEffect(() => trackMouse(stdout), [stdout]);

  // The transcript is the model; the view is a pure function of it.
  useEffect(() => {
    const render = () => {
      const records = runtime.transcript.all();
      setItems(
        buildView(records, runtime.workspace.dir, {
          expandedTasks: openTasks,
          expandHint: EXPAND_HINT,
        }),
      );
      setWorking(workingAgents(records));
      setPhase(turnPhase(records));
      setSessions(sessionsOf(records));
    };
    render();
    runtime.transcript.on('record', render);
    return () => {
      runtime.transcript.off('record', render);
    };
  }, [runtime, openTasks]);

  // Being here is what turns an `ask` verdict into a real question, and an
  // agent that stopped to ask something into a form. Without a mounted UI the
  // policy engine denies the first and cancels the second.
  useEffect(() => {
    // One question at a time, in the order they arrived: a second agent that
    // stops while the first is being answered waits its turn rather than
    // overwriting the question on screen. `head` is that queue's front, kept
    // synchronously, because an abort can retire a question between renders.
    const show = (entry: Question) => {
      if (head.current) {
        pending.current.push(entry);
        return;
      }
      head.current = entry;
      applyForm(entry.kind === 'input' ? blankForm(entry.fields) : undefined);
      setAsk(entry);
    };
    // A question that answers itself — a timeout, a withdrawn request — may be
    // anywhere in the line, not necessarily on screen.
    const retire = (entry: Question) => {
      if (head.current !== entry) {
        pending.current = pending.current.filter((waiting) => waiting !== entry);
        return;
      }
      const following = pending.current.shift();
      head.current = following;
      applyForm(following?.kind === 'input' ? blankForm(following.fields) : undefined);
      setAsk(following);
    };
    /** Answering is once and for all, whoever gets there first. */
    const settle = <T,>(entry: () => Question, resolve: (value: T) => void) => {
      let done = false;
      return (value: T) => {
        if (done) return;
        done = true;
        resolve(value);
        retire(entry());
      };
    };

    runtime.setEscalator({
      ask: (question) =>
        new Promise<boolean>((resolve) => {
          let entry: Question;
          const answer = settle<boolean>(() => entry, resolve);
          entry = {
            kind: 'ask',
            summary: question.summary,
            detail: question.detail,
            rule: question.rule,
            agentId: question.context.agentId,
            answer,
          };
          question.signal.addEventListener('abort', () => answer(false), { once: true });
          show(entry);
        }),
      input: (question) =>
        new Promise<InputAnswer>((resolve) => {
          let entry: Question;
          const answer = settle<InputAnswer>(() => entry, resolve);
          entry = {
            kind: 'input',
            summary: question.summary,
            agentId: question.context.agentId,
            fields: question.fields,
            answer,
          };
          question.signal.addEventListener('abort', () => answer({ action: 'cancel' }), {
            once: true,
          });
          show(entry);
        }),
    });
    return () => runtime.setEscalator(undefined);
  }, [runtime]);

  // `cli-highlight` drags highlight.js behind it, so it is fetched in the
  // background and code blocks render plain until it arrives — one extra
  // render, a moment after launch.
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  useEffect(() => {
    let live = true;
    void loadHighlighter().then((loaded) => {
      if (live) setHighlighter(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  const rows = stdout?.rows ?? 30;
  const columns = stdout?.columns ?? 80;
  // What the menu may claim before it starts eating the transcript's floor. On
  // a short terminal that is nothing at all: losing the menu is much the
  // cheaper of the two ways a fixed frame can fail.
  const budgeted = (offered: MenuItem[]): MenuItem[] =>
    offered.length === 0 ? offered : offered.slice(0, menuFit(offered[0]!.kind, rows));
  // Who a mention can name. The roster is fixed for the life of the run, so
  // reading it once is enough.
  const agents = useMemo(() => runtime.pool.available(), [runtime]);
  // What each agent's live session says it can be. Every agent is woken at
  // launch rather than when a `:` first wants the answer, because the waiting
  // is all in `session/new`: an adapter fetched by `npx`, a process, a
  // handshake, seconds of it. Spent while the first line is still being typed,
  // the colon's menu is simply there — and the first task goes to an agent
  // already awake.
  const [modelRoster, setModelRoster] = useState<Record<string, RosterState>>({});
  useEffect(() => {
    for (const id of agents) {
      // A session that will not open is kept apart from one that opened with
      // nothing to offer. The two look identical — no menu — and mean opposite
      // things, and telling them apart is the difference between "this agent
      // has one model" and "this agent never started".
      runtime.pool
        .session(id)
        .then(() => setModelRoster((prev) => ({ ...prev, [id]: 'ready' })))
        .catch((err: unknown) => {
          // Said once, on the record, at the moment it is known: an agent that
          // will not start is news now rather than at the first task sent to it.
          const failed = (err as Error).message;
          runtime.transcript.append({ type: 'note', level: 'warn', text: failed });
          setModelRoster((prev) => ({ ...prev, [id]: { failed } }));
        });
    }
  }, [agents, runtime]);
  // The status line under the prompt: each agent as the model it is actually
  // on, and whether it holds an open task right now. An agent that names no
  // model anywhere goes by its own id. The roster is a dependency for what it
  // says about the pool rather than for itself: an entry landing is a session
  // having answered, which is the moment that session first has a model to name.
  const agentStatus = useMemo(
    () =>
      agents.map((id) => ({
        id,
        label: runtime.pool.currentModel(id) ?? id,
        busy: working.has(id),
      })),
    [agents, working, runtime, modelRoster],
  );
  // The planner leads the roll: it is upstream of every agent on it, and where
  // the line runs out of room it is the last thing worth losing. It is working
  // whenever a turn is open and no agent holds a task — choosing what to do
  // next, or writing the answer; once a task is out, it is waiting like anyone.
  const status = [plannerStatus(runtime.config, busy && working.size === 0), ...agentStatus];
  /** The rows a half-written draft earns: commands for a slash, agents for an at-sign, models for a colon. */
  const offeredFor = (d: Draft): MenuItem[] => {
    const commands = suggest(d.value, runtime.commands);
    if (commands.length > 0) return commands.map((command) => ({ kind: 'command', command }));
    const token = modelTokenAt(d.value, d.cursor, agents);
    if (token) {
      return suggestModels(token.query, runtime.pool.models(token.agent)).map((choice) => ({
        kind: 'model',
        agent: token.agent,
        choice,
      }));
    }
    const planner = plannerTokenAt(d.value, d.cursor);
    return suggestAgents(d.value, d.cursor, agents).map((id) => ({
      kind: 'agent',
      id,
      ...(planner ? { planner: true as const } : {}),
      note:
        id === ORCHESTRATOR
          ? 'the model that routes — :agent:model moves it'
          : agentRole(runtime.config, id),
    }));
  };
  const menu = useMemo(
    () => (ask || dismissed === draft.value ? [] : budgeted(offeredFor(draft))),
    // offeredFor is rebuilt every render but reads only what is listed here.
    [ask, dismissed, draft, runtime.commands, agents, rows, modelRoster],
  );
  // What a colon says when it has no rows to show, because an empty menu and a
  // silent one are the same sight and mean different things: an agent still
  // coming up will have models in a moment, and one that answered with none
  // has none to give — its model was settled at launch, and only its profile
  // can move it. Saying so is the whole point; the silence is what read as a
  // bug. A name typed at a roster that does have models gets nothing, the way
  // a mistyped command gets nothing.
  const modelNote = useMemo(() => {
    if (ask || dismissed === draft.value || menu.length > 0) return undefined;
    const token = modelTokenAt(draft.value, draft.cursor, agents);
    if (!token) return undefined;
    if (runtime.pool.models(token.agent).length > 0) return undefined;
    const state = modelRoster[token.agent];
    if (state === undefined) return `waking ${token.agent}…`;
    // Why there is no roster, in the agent's own words where it gave any.
    if (state !== 'ready') return state.failed;
    const on = runtime.pool.currentModel(token.agent);
    return (
      `${token.agent} offers no model selection over ACP` +
      (on ? ` · on ${on}, set by its launch profile` : '')
    );
  }, [ask, dismissed, draft, agents, menu, modelRoster, runtime]);
  // The menu's own rows — or the one line standing in for them — plus the blank
  // line that keeps either off the transcript.
  const promptRows = PROMPT_ROWS + (menu.length > 0 ? menu.length + 1 : modelNote ? 2 : 0);
  // An agent's own words arrive as markdown, so they are drawn as markdown.
  // This sits above the windowing rather than inside `Entry` because the rows a
  // block occupies are what the viewport below and every click are measured
  // against — both have to see the same text the terminal will.
  const drawn = useMemo(
    () =>
      items.map((item, index) => {
        // The transcript's first row sits against the header, which already
        // ends in a blank line, so it gives up the gap it would have had
        // anywhere further down.
        const placed = index === 0 && item.gap ? { ...item, gap: false } : item;
        if (placed.prose !== true) return placed;
        return {
          ...placed,
          text: renderMarkdown(placed.key, placed.text, {
            highlight: highlighter,
            // A thought stays the quieter register, so the quiet ink is baked
            // into the styling rather than painted over it.
            dim: placed.tone === 'muted',
          }),
          // The ANSI carries every colour it needs; an outer one would end at
          // the first reset inside it.
          tone: 'normal' as Tone,
        };
      }),
    [items, highlighter],
  );

  // The rows the transcript gets: everything the header and the prompt leave,
  // the menu's rows included — an open menu shortens the pane rather than
  // spilling over it. The floor is the one the menu was budgeted against, so
  // the two agree and the frame stays inside the window; a window too small to
  // hold even that spills rather than the transcript vanishing.
  const viewport = Math.max(
    rows - 1 - HEADER_ROWS - promptRows,
    menu[0]?.kind === 'model' ? MODEL_FLOOR : MENU_FLOOR,
  );
  const height = useMemo(() => totalHeight(drawn, columns), [drawn, columns]);
  // Whether the transcript has anything to show. Empty and with nothing being
  // asked, the pane carries the greeting instead — this run's first frame, and
  // the only one it appears on: the first record sent or received retires it.
  const greeting = items.length === 0 && ask === undefined;
  const furthest = Math.max(0, height - viewport);
  // How far down the transcript the top of the viewport sits, or `undefined`
  // while it follows the end — which is not the same number: pinned to the
  // bottom, the view keeps up as the transcript grows under it, and a fixed
  // offset would fall behind by whatever arrived.
  const [scrolled, setScrolled] = useState<number | undefined>(undefined);
  const from = Math.min(scrolled ?? furthest, furthest);
  // What a scroll is measured against, for the handler below: several wheel
  // reports can arrive in one stdin chunk and all be handled before a render,
  // so the bounds are read from here rather than from the closure.
  const bounds = useRef({ furthest, viewport, from, height });
  bounds.current = { furthest, viewport, from, height };
  /** Moves the viewport by `delta` rows, and re-pins it at the end. */
  const moveBy = (delta: number) =>
    setScrolled((current) => {
      const { furthest: end } = bounds.current;
      const next = Math.min(Math.max((current ?? end) + delta, 0), end);
      return next >= end ? undefined : next;
    });
  // Rows asked for but not yet shown, and the timer paying them off. Both are
  // refs: the drain reads and writes them between renders, and a render owes
  // nothing to either.
  const owed = useRef(0);
  const drainTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drain = () => {
    const debt = owed.current;
    const size = Math.abs(debt);
    const cap = Math.max(1, bounds.current.viewport - 1);
    const step = Math.min(cap, Math.max(SCROLL_STEP, (size * 3) >> 2));
    const paid = size <= step ? debt : Math.sign(debt) * step;
    owed.current = debt - paid;
    if (paid !== 0) moveBy(paid);
    drainTimer.current = owed.current === 0 ? undefined : setTimeout(drain, DRAIN_MS);
  };
  /** Owes the viewport `delta` rows; the drain pays them out over frames. */
  const scrollBy = (delta: number) => {
    owed.current += delta;
    // The first payment waits a beat rather than running here, so a burst
    // fused into one stdin chunk pools in full before any of it is drawn.
    drainTimer.current ??= setTimeout(drain, 0);
  };
  // A timer still owed rows must not outlive the component it scrolls.
  useEffect(() => () => clearTimeout(drainTimer.current), []);

  // Placement and rendering share the window, or a click would be aimed at a
  // different frame than the one on screen.
  const { items: shown, top } = useMemo(
    () => windowAt(drawn, viewport, columns, from),
    [drawn, viewport, columns, from],
  );
  const placements = useMemo(
    () => placeItems(shown, columns, HEADER_ROWS + top),
    [shown, columns, top],
  );

  const tasks = useMemo(
    () => new Set(shown.map((item) => item.taskId).filter((id) => id !== undefined)),
    [shown],
  );
  const allOpen = tasks.size > 0 && [...tasks].every((id) => openTasks.has(id));
  // Mouse rows are screen rows, but the frame starts wherever the shell prompt
  // left it — so where it sits is measured, not assumed. After each layout
  // settles the terminal is asked where its cursor is; Ink parks it on the
  // line under the frame, and the frame is a fixed rows-1 tall, so the answer
  // minus that height is the frame's first row. Until the first answer lands,
  // clicks assume a fresh terminal: the frame immediately below the command
  // that launched us.
  const frameTop = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!stdout?.isTTY) return;
    // Past Ink's render throttle, so the answer describes this frame.
    const timer = setTimeout(() => stdout.write(CURSOR_QUERY), 80);
    return () => clearTimeout(timer);
  }, [stdout, placements]);

  const toggleTask = (taskId: number) =>
    setOpenTasks((current) => {
      const next = new Set(current);
      if (!next.delete(taskId)) next.add(taskId);
      return next;
    });

  // Mouse reports arrive through Ink's input parser. Do not attach a `data`
  // listener to stdin here: it switches the stream to flowing mode and races
  // Ink's `readable` listener, which can freeze keyboard input after a render.
  const layout = useRef(placements);
  layout.current = placements;

  /**
   * Ends the selection: the characters it crossed go to the clipboard,
   * counted. A selection holding nothing but air — a drag across a gap — is
   * let go without a word.
   */
  const copySelection = () => {
    const held = selectionRef.current;
    applySelection(undefined);
    if (!held) return;
    const text = selectedText(visualRows(drawn, columns), order(held.anchor, held.focus));
    if (text.trim() === '') return;
    copyToClipboard(text, stdout);
    clearTimeout(copiedTimer.current);
    setCopied(text.split('\n').length);
    copiedTimer.current = setTimeout(() => setCopied(undefined), 2500);
  };

  // The selection as the renderer needs it: put in reading order, and moved
  // from transcript rows to screen rows — the coordinates every placement and
  // every repainted line is measured in.
  const shownSelection = useMemo(() => {
    if (!selection) return undefined;
    const { start, end } = order(selection.anchor, selection.focus);
    const shift = (point: Point): Point => ({ row: point.row - from + HEADER_ROWS, col: point.col });
    return { start: shift(start), end: shift(end) };
  }, [selection, from]);

  const start = (text: string) => {
    setStartedAt(Date.now());
    void runtime.conversation.send(text).finally(() => setStartedAt(undefined));
  };

  const submit = (text: string) => {
    const trimmed = text.trim();
    applyDraft(() => ({ value: '', cursor: 0 }));
    dismissedRef.current = undefined;
    setDismissed(undefined);
    if (trimmed === '') return;
    // Sent is sent: it joins the prompt's memory whether it goes to the model,
    // to an agent, or nowhere but a local command, because the arrows walk
    // back through what was typed rather than through what became of it.
    historyRef.current = remember(historyRef.current, trimmed);
    // Whatever was being read further up, the answer to what was just sent is
    // what matters now: sending follows the end again — and forgives whatever
    // scroll was still owed, or the drain would drag the view straight back.
    owed.current = 0;
    setScrolled(undefined);

    const parsed = parseSlashCommand(trimmed);
    const command = parsed ? findCommand(parsed.name, runtime.commands) : undefined;

    if (command?.kind === 'local' && command.interactive) {
      // The commands only this seat can carry out. Leaving is close, not
      // cancel: a cancel would still summarise the turn, and that request
      // would keep the process alive after the UI is gone.
      const effect = command.run(parsed?.args ?? '', runtime.commandHost(`/${command.name}`));
      if (effect.do === 'quit') {
        void runtime.conversation.close();
        exit();
      }
      return;
    }

    // A command handsfree answers itself is over the moment it runs, so it
    // never queues behind a turn and never wears the spinner.
    if (command?.kind === 'local') {
      void runtime.conversation.send(trimmed);
      return;
    }

    // Everything else the user sends mid-turn takes its place in line behind
    // the turn already running.
    if (busy) {
      setQueued((line) => [...line, trimmed]);
      return;
    }
    start(trimmed);
  };

  // Whatever was typed mid-turn goes in one at a time, each one waiting for the
  // one before it — a queue drained all at once would race the conversation,
  // which takes a single turn.
  useEffect(() => {
    if (busy || queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    start(next!);
    // `start` is rebuilt every render and is deliberately not a dependency:
    // the queue and whether a turn is running are what decide when one leaves.
  }, [busy, queued]);

  // The prompt is edited here, not by a text-input component. A second
  // component would keep its own cursor state and see every keypress this
  // handler sees — including the mouse and cursor reports above — and there is
  // no way to stop Ink handing it a report it would type into the value.
  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      void runtime.conversation.close();
      exit();
      return;
    }
    const cursorRow = parseCursorReport(char);
    if (cursorRow !== undefined) {
      // The frame fills the window whatever it holds, so the answer minus its
      // fixed height is the frame's first row — even while an ask is up.
      frameTop.current = Math.max(0, cursorRow - (rows - 1));
      return;
    }
    // A question owns the screen while it is up — it is taller than the prompt
    // it stands in for, so the transcript above it gives up rows and no longer
    // sits where a click was measured against. Answering it is the only input
    // that lands.
    if (ask) {
      if (ask.kind === 'ask') {
        if (char === 'y' || char === 'Y') ask.answer(true);
        if (char === 'n' || char === 'N' || key.escape) ask.answer(false);
        return;
      }
      // Esc is a refusal, not a dismissal: the agent is told a person said no,
      // which is a different thing from nobody having been there.
      if (key.escape) {
        ask.answer({ action: 'decline' });
        return;
      }
      // A mouse report is printable text, and a form has a text field in it:
      // without this, moving the pointer types coordinates into the answer.
      if (isMouseReport(char)) return;
      const state = formRef.current;
      const field = state && ask.fields[state.index];
      if (!state || !field) return;
      const next = typed(ask.fields, state, field, char, key);
      // Answering re-points the form at whatever question comes next, so the
      // last field must not write over it on the way out.
      if (next.done) ask.answer({ action: 'accept', content: next.values });
      else applyForm(next.state);
      return;
    }
    if (isMouseReport(char)) {
      const mouse = parseMouseEvent(char);
      if (!mouse) return;
      if (mouse.type === 'wheel') {
        scrollBy(mouse.direction === 'up' ? -WHEEL_ROWS : WHEEL_ROWS);
        return;
      }
      // A clipped item reaches above the viewport and below it, so a row
      // outside the transcript is nobody's — the header and the prompt are not
      // clickable, and the item hanging over their edge must not be either.
      const row = mouse.row - (frameTop.current ?? (stdout?.isTTY ? 1 : 0));
      const inside = row >= HEADER_ROWS && row < HEADER_ROWS + bounds.current.viewport;
      if (mouse.type === 'hover') {
        setHoveredTask(inside ? itemAt(layout.current, row)?.taskId : undefined);
        return;
      }
      // A mouse row, taken into the transcript: clamped into the pane first —
      // a drag that wanders over the header or the prompt keeps its grip on
      // the nearest row — and then onto a row the transcript actually has.
      const cellAt = (at: number, column: number): Point | undefined => {
        const { viewport: rows_, from: from_, height: height_ } = bounds.current;
        if (height_ === 0) return undefined;
        const pane = Math.min(Math.max(at, HEADER_ROWS), HEADER_ROWS + rows_ - 1);
        return {
          row: Math.min(Math.max(pane - HEADER_ROWS + from_, 0), height_ - 1),
          col: column,
        };
      };
      if (mouse.type === 'press') {
        applySelection(undefined);
        const anchor = inside ? cellAt(row, mouse.column) : undefined;
        dragRef.current = anchor && { anchor, moved: false };
        return;
      }
      if (mouse.type === 'drag') {
        const drag = dragRef.current;
        if (!drag) return;
        const focus = cellAt(row, mouse.column);
        if (!focus) return;
        // Terminals in drag mode can report a motion that never left the
        // anchor's cell; taking it would turn a plain click into a one-cell
        // selection. Once the drag is real, motion back over the anchor still
        // counts — that is how a selection is pulled back in.
        if (!drag.moved && focus.row === drag.anchor.row && focus.col === drag.anchor.col) return;
        drag.moved = true;
        applySelection({ anchor: drag.anchor, focus });
        return;
      }
      // The release: a drag that moved is a selection, finished by copying it;
      // one that never moved is the click it always was, and folds or unfolds
      // the task it landed on.
      const drag = dragRef.current;
      dragRef.current = undefined;
      if (drag?.moved) {
        copySelection();
        return;
      }
      const taskId = inside ? itemAt(layout.current, row)?.taskId : undefined;
      if (taskId !== undefined) toggleTask(taskId);
      return;
    }
    // Folded tasks are still in the transcript; this is the way back to all of
    // them at once, where a click opens the one it landed on.
    if (key.ctrl && char === 'o') {
      setOpenTasks(allOpen ? new Set() : new Set(tasks));
      return;
    }
    // Scrolling the transcript, for the times the wheel is not where the hands
    // are. This sits above the menu because the menu owns the plain arrows for
    // its own selection: the shift is what says the transcript is meant, and
    // the page keys never belong to a list five rows tall.
    if (key.shift && (key.upArrow || key.downArrow)) {
      scrollBy(key.upArrow ? -1 : 1);
      return;
    }
    if (key.pageUp || key.pageDown) {
      // A page keeps one row of what was on screen, so the eye has somewhere
      // to land.
      const page = Math.max(1, bounds.current.viewport - 1);
      scrollBy(key.pageUp ? -page : page);
      return;
    }
    // The menu, worked out here rather than read from the memo above: several
    // keys can arrive in one chunk, and the memo still describes the draft as
    // it was before any of them were handled.
    const offered =
      dismissedRef.current === draftRef.current.value
        ? []
        : budgeted(offeredFor(draftRef.current));
    if (offered.length > 0) {
      const move = (by: number): void => {
        const next = (selectedRef.current + by + offered.length) % offered.length;
        selectedRef.current = next;
        setSelected(next);
      };
      if (key.downArrow || (key.ctrl && char === 'n')) return move(1);
      if (key.upArrow || (key.ctrl && char === 'p')) return move(-1);
      if (key.escape) {
        // One escape closes the menu, a second stops the turn. Aiming at a
        // command is no reason to lose the way to interrupt what is running.
        dismissedRef.current = draftRef.current.value;
        setDismissed(draftRef.current.value);
        return;
      }
      if (key.tab || key.return) {
        const chosen = offered[Math.min(selectedRef.current, offered.length - 1)]!;
        // An agent is only ever filled in, never sent: the mention opens a
        // task, and the task is still to be written after the name. No space
        // follows it, so a colon can — but that leaves the finished name still
        // wearing an open menu, and enter would fill it in forever; waving the
        // menu away for exactly this text is what hands enter back to sending.
        if (chosen.kind === 'agent') {
          applyDraft((d) => completeMention(d, chosen.id));
          dismissedRef.current = draftRef.current.value;
          setDismissed(draftRef.current.value);
          return;
        }
        // A model is filled in the same way; the trailing space closes the
        // address, so the menu falls shut on its own.
        if (chosen.kind === 'model') {
          applyDraft((d) => completeModel(d, agents, chosen.choice.value));
          return;
        }
        // Enter sends a command that wants nothing further; one with arguments
        // still to write is filled in and left for the user to finish.
        if (key.return && !takesArguments(chosen.command)) {
          submit(`/${chosen.command.name}`);
          return;
        }
        const filled = `/${chosen.command.name} `;
        applyDraft(() => ({ value: filled, cursor: [...filled].length }));
        return;
      }
    }
    if (key.escape) {
      // A cancelled turn ends in silence, and so does everything queued behind
      // it — one escape stops the whole thing, not just the turn on screen.
      if (busy) {
        setQueued([]);
        runtime.conversation.cancel();
      }
      return;
    }
    if (key.return) {
      submit(draftRef.current.value);
      return;
    }
    // With no menu open the plain arrows are the prompt's memory: up walks
    // back through the lines this run has sent, down comes forward again and
    // ends on whatever was half-written when the walk began. The cursor lands
    // at the end of the recalled line, where the next word would go.
    if (key.upArrow || key.downArrow || (key.ctrl && (char === 'p' || char === 'n'))) {
      const back = key.upArrow || char === 'p';
      const stepped = recall(historyRef.current, draftRef.current.value, back ? 'back' : 'forward');
      // Nowhere to go: the oldest line is already up, or the draft is.
      if (!stepped) return;
      applyDraft(() => ({ value: stepped.value, cursor: [...stepped.value].length }));
      historyRef.current = stepped.history;
      return;
    }
    if (key.leftArrow) {
      applyDraft((d) => ({ ...d, cursor: Math.max(0, d.cursor - 1) }));
      return;
    }
    if (key.rightArrow) {
      applyDraft((d) => ({ ...d, cursor: Math.min([...d.value].length, d.cursor + 1) }));
      return;
    }
    if (key.home || (key.ctrl && char === 'a')) {
      applyDraft((d) => ({ ...d, cursor: 0 }));
      return;
    }
    if (key.end || (key.ctrl && char === 'e')) {
      applyDraft((d) => ({ ...d, cursor: [...d.value].length }));
      return;
    }
    if (key.backspace) {
      applyDraft((d) => {
        if (d.cursor === 0) return d;
        const chars = [...d.value];
        chars.splice(d.cursor - 1, 1);
        return { value: chars.join(''), cursor: d.cursor - 1 };
      });
      return;
    }
    // Forward delete: fn+delete on a Mac keyboard, the Delete key elsewhere.
    if (key.delete) {
      applyDraft((d) => {
        const chars = [...d.value];
        if (d.cursor >= chars.length) return d;
        chars.splice(d.cursor, 1);
        return { ...d, value: chars.join('') };
      });
      return;
    }
    // Chords and special keys carry no text to type; Ink hands the latter to
    // us as an empty string.
    if (key.ctrl || key.meta || key.tab || char === '') return;
    // Keys or a paste fused into one stdin chunk arrive as a single event
    // whose `return` flag is never set — a line break inside the text is the
    // enter it carries, so it submits right where it sits.
    for (const [index, segment] of char.split(/\r\n|[\r\n]/).entries()) {
      if (index > 0) submit(draftRef.current.value);
      if (segment === '') continue;
      applyDraft((d) => {
        const chars = [...d.value];
        const typed = [...segment];
        chars.splice(d.cursor, 0, ...typed);
        return { value: chars.join(''), cursor: d.cursor + typed.length };
      });
    }
  });

  // The frame takes the whole window minus the line Ink keeps the cursor on:
  // the transcript's pane takes every row the header and the prompt leave, so
  // the prompt stays at the bottom while what is above it scrolls, the way
  // Claude Code's chat sits under its welcome mark.
  return (
    <Box flexDirection="column" height={rows - 1}>
      <Header runtime={runtime} brief={brief} sessions={sessions} />

      {/*
        The transcript's window: a fixed pane the prompt sits under, with the
        drawn column nudged up by the rows scrolled past its top. An item at
        either edge is drawn whole and clipped here, so the view moves a row at
        a time instead of jumping a message at a time.

        It gives up rows only to a question, which is taller than the prompt it
        replaces; nothing is clickable while one is up, so the rows it takes
        cost no aim.
      */}
      <Box
        flexDirection="column"
        height={viewport}
        flexShrink={ask ? 1 : 0}
        overflowY="hidden"
        // Nothing has been said yet: the greeting is laid against the foot of
        // the pane, so it sits on the prompt rather than adrift at the top of
        // an empty screen. A transcript fills the pane from the top as ever.
        justifyContent={greeting ? 'flex-end' : 'flex-start'}
      >
        {greeting ? (
          <Welcome runtime={runtime} agents={agents} rows={viewport} />
        ) : (
          <Box flexDirection="column" flexShrink={0} marginTop={top}>
            {shown.map((item, index) => {
              const hovered = hoveredTask !== undefined && item.taskId === hoveredTask;
              const opened = item.taskId !== undefined && openTasks.has(item.taskId);
              const band = hovered ? HOVER_BAND : opened ? BAND : undefined;
              return (
                <Entry
                  key={item.key}
                  item={item}
                  band={band}
                  bridged={band !== undefined && shown[index - 1]?.taskId === item.taskId}
                  agents={agents}
                  top={placements[index]?.top ?? 0}
                  columns={columns}
                  selection={shownSelection}
                />
              );
            })}
          </Box>
        )}
      </Box>

      {menu.length > 0 ? (
        <Suggestions items={menu} selected={selected} />
      ) : modelNote ? (
        <MenuNote text={modelNote} />
      ) : null}

      {ask ? (
        ask.kind === 'ask' ? (
          <Ask ask={ask} />
        ) : (
          <Elicit question={ask} form={form} />
        )
      ) : (
        <Prompt
          draft={draft}
          agents={agents}
          status={status}
          startedAt={startedAt}
          queued={queued.length}
          allOpen={allOpen}
          following={scrolled === undefined}
          copied={copied}
          cwd={runtime.workspace.dir}
        />
      )}
    </Box>
  );
}

/**
 * Whether the mark's eyes are shut this frame. One timer at a time, chained:
 * a long random wait, a blink, and now and then a second blink a beat later.
 * Nothing here runs while a turn does — it is a couple of renders a minute.
 */
function useBlink(): boolean {
  const [shut, setShut] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    // `again` counts the blinks still owed after this one, so a pair never
    // grows into a chain.
    const close = (again: number) => {
      setShut(true);
      timer = setTimeout(() => open(again), BLINK_SHUT_MS);
    };
    const open = (again: number) => {
      setShut(false);
      timer =
        again > 0
          ? setTimeout(() => close(again - 1), between(BLINK_AGAIN_MS))
          : setTimeout(() => close(Math.random() < 0.5 ? 1 : 0), between(BLINK_WAIT_MS));
    };
    open(0);
    return () => clearTimeout(timer);
  }, []);
  return shut;
}

/**
 * Where the mark stands on its stage, how it holds itself, which way it is
 * looking, and what, if anything, it is saying.
 */
type Pose = {
  x: number;
  stance?: Stance;
  look?: Look;
  say?: string;
  side?: 'left' | 'right';
};

/**
 * The mark's wandering, one timer at a time, chained: a breather at the
 * middle of its stage, then an outing — a clean exit off the left edge, a
 * peek back, a hop to anywhere on the stage, a word thrown from right where
 * it stands, a jump on the spot, a sit on the ground, or a spell at ease
 * with its arms dropped — and as long as the mood holds, another. A saying
 * goes out the side the mark has space on, so it lands left of the mark as
 * readily as right. The stage itself never moves — `stage` clips the walk
 * at its left edge — so the margin holds however far the mark goes.
 *
 * `brief` is what there is to report, if anything. While it is set the mark
 * speaks the phase rather than its own idle sayings, breathes shorter
 * between outings, and takes the first outing after a phase turns to say so
 * — the news is what a briefing is for, and the roulette is no way to
 * deliver it. Everything else about the wander is unchanged: it walks, sits
 * and jumps through a turn exactly as it does through the quiet.
 */
function useWander(brief?: Brief): Pose {
  const [pose, setPose] = useState<Pose>({ x: WANDER_HOME });
  // The chain of timers is set up once and outlives every render, so what it
  // reads has to be a ref rather than the closed-over prop.
  const briefRef = useRef(brief);
  briefRef.current = brief;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    // The phase the last briefing announced, so a turn is reported when it
    // moves on and not once a roll of the dice happens to allow it.
    let told: Brief | undefined;
    // The one column the mark actually stands on; every chained step moves
    // it one cell and shows that cell, so a walk can start from anywhere.
    let at = WANDER_HOME;
    // The eyes lead the walk: a mark whose face never turns reads as a logo
    // being slid across the row rather than as something going somewhere.
    // They hold that way through the pause the walk ends on — only the next
    // pose puts them back straight — so a step and a stop are the same mark.
    const walk = (to: number, then: () => void) => {
      if (at === to) return then();
      const look: Look = to > at ? 'right' : 'left';
      at += Math.sign(to - at);
      setPose({ x: at, look });
      timer = setTimeout(() => walk(to, then), WANDER_STEP_MS);
    };
    const rest = () => {
      setPose({ x: at });
      timer = setTimeout(outing, between(briefRef.current ? WANDER_BRIEF_MS : WANDER_HOME_MS));
    };
    // Anything worth watching happens on stage: a word, a jump, or a sit
    // from an empty stage reads as a glitch rather than a joke, so offstage
    // the mark first comes home.
    const seen = (deed: (then: () => void) => void, then: () => void) => {
      if (at < 0) return walk(WANDER_HOME, () => deed(then));
      deed(then);
    };
    // A word goes out from wherever the mark already stands — the stage
    // keeps room for the widest saying on each side of any visible column,
    // so the mark never shuffles to make space. Which side only matters
    // when both fit.
    const speak = (then: () => void) => {
      const phase = briefRef.current;
      told = phase;
      const words: readonly string[] = phase ? BRIEFINGS[phase] : SAYINGS;
      const saying = words[Math.floor(Math.random() * words.length)] ?? '';
      const width = columns(saying);
      const fitsRight = at + WANDER_SPAN + 1 + width <= MASCOT_STAGE;
      const fitsLeft = at - 1 - width >= 0;
      const side =
        fitsRight && fitsLeft ? (Math.random() < 0.5 ? 'right' : 'left') : fitsRight ? 'right' : 'left';
      // Looking at its own word, whichever side it went out.
      setPose({ x: at, say: saying, side, look: side });
      timer = setTimeout(then, between(SAY_MS));
    };
    // A stance held where the mark stands, then let go.
    const hold = (stance: Stance, ms: number, then: () => void) => {
      setPose({ x: at, stance });
      timer = setTimeout(then, ms);
    };
    const sit = (then: () => void) => hold('sit', between(SIT_MS), then);
    const ease = (then: () => void) => hold('easy', between(EASY_MS), then);
    // A jump is three beats — the dip, the hang, the landing — and while the
    // spring holds, another off the same landing.
    const jump = (then: () => void) => {
      hold('sit', JUMP_DIP_MS, () =>
        hold('air', JUMP_AIR_MS, () => {
          setPose({ x: at });
          timer = setTimeout(() => (Math.random() < 0.4 ? jump(then) : then()), JUMP_LAND_MS);
        }),
      );
    };
    const onward = () => {
      timer = setTimeout(() => {
        if (Math.random() < 0.6) return outing();
        walk(WANDER_HOME, rest);
      }, between(WANDER_PAUSE_MS));
    };
    const outing = () => {
      // News beats the roulette: a phase nobody has been told about goes out
      // on the next outing whatever it was going to be. Between phases the
      // mark still speaks now and then, so a long stretch of one phase is
      // not a mark that has gone quiet.
      if (briefRef.current !== told) return seen(speak, onward);
      const roll = Math.random();
      if (roll < 0.2) return seen(speak, onward);
      if (roll < 0.34) return seen(jump, onward);
      if (roll < 0.46) return seen(sit, onward);
      if (roll < 0.56) return seen(ease, onward);
      const target =
        roll < 0.72
          ? -WANDER_SPAN
          : roll < 0.82
            ? 2 - WANDER_SPAN
            : Math.floor(Math.random() * (WANDER_ROAM + 1));
      walk(target, onward);
    };
    // The first outing comes on the heels of the opening frame — a mark that
    // holds its launch pose for half a minute reads as a static logo.
    setPose({ x: at });
    timer = setTimeout(outing, between(WANDER_OPEN_MS));
    return () => clearTimeout(timer);
  }, []);
  return pose;
}

/**
 * The welcome mark, in the shape Claude Code opens with: the condensed logo on
 * the left and three facts beside it — what this is, what is answering, and the
 * run's own directory under the handsfree root, where the transcript and the
 * session ids are kept and, on a sandbox run, the workspace itself sits. The
 * directory the agents actually work in is not here: it belongs beside the
 * prompt, on the line the work is typed on. No box and no tips column; the
 * shortcuts already live under the prompt. A blank row and a column of air sit
 * on every side of it.
 *
 * Kept to exactly HEADER_ROWS rows — that constant is what a click's row is
 * measured against — so every line truncates rather than wraps, and the tail
 * of the path is the part worth keeping.
 */
function Header({
  runtime,
  brief,
  sessions = {},
}: {
  runtime: Runtime;
  brief?: Brief;
  sessions?: Record<string, 'new' | 'resumed'>;
}): React.JSX.Element {
  const { x, stance, look, say, side } = useWander(brief);
  const mark = stage(mascot(stance, useBlink(), look), x, say, side);
  const agents = Object.entries(runtime.config.agents)
    .filter(([, profile]) => profile.enabled)
    .map(([id]) => id);
  const orchestration = runtime.config.orchestration;
  const brain =
    orchestration.provider === 'acp'
      ? `${orchestration.acp.agent} (acp)`
      : orchestration.local.model;
  return (
    <Box margin={1} gap={2} flexShrink={0}>
      <Box flexDirection="column" flexShrink={0} width={MASCOT_STAGE}>
        {mark.map((line, index) => (
          <Text key={index} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        <Text wrap="truncate">
          <Text bold>handsfree</Text>
          <Text color={INK}>{` v${VERSION}`}</Text>
        </Text>
        <Text color={INK} wrap="truncate">
          {`${brain} · `}
          {agents.map((id, index) => (
            <Text key={id}>
              {index > 0 ? ', ' : ''}
              <Text color={agentColour(id)}>{id}</Text>
            </Text>
          ))}
          {resumedLine(agents.filter((id) => sessions[id] === 'resumed'))}
        </Text>
        <Text color={INK} wrap="truncate-start">
          {tildify(runtime.workspace.runDir)}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * One row of the transcript. Whatever the agent sent — prose, a thought, a tool
 * call and what it printed — arrives here already shaped; this only decides
 * where it sits and what colour it wears.
 *
 * A task left open wears a faint wash so it reads as one continuous block, and
 * hovering it brightens the band. The blank line above an item belongs to the
 * band only when the row before it is part of the same task — `bridged` — so
 * the block never bleeds upward into whatever it was delegated from.
 *
 * A delegated row spends its agent's own colour wherever the house accent
 * would otherwise go — the bullet and the name — so two tasks running one
 * after the other are told apart by colour before either name is read.
 */
function Entry({
  item,
  band,
  bridged,
  agents,
  top,
  columns,
  selection,
}: {
  item: ViewItem;
  band: string | undefined;
  bridged: boolean;
  agents: readonly string[];
  /** The item's first screen row, from the same placement a click is aimed by. */
  top: number;
  columns: number;
  /** The selection in screen rows, already in reading order. */
  selection: Bounds | undefined;
}): React.JSX.Element {
  const accent = item.agentId ? agentColour(item.agentId) : undefined;
  // The user's own line wears its faint wash whether or not anything else is
  // going on; a task's band and the hover still win, because they only exist
  // on rows that are not the user's.
  const wash = band ?? (item.marker === 'prompt' ? PROMPT_BAND : undefined);
  const indent = item.depth * 2;
  const rows = itemRows(item, columns);
  const gutter = GLYPH[item.marker];
  // Where a block's first *rendered* line sits. The pane clips an item
  // straddling its top edge before Ink hands the surviving lines to a
  // transform, so a block reaching above the pane starts, as far as its
  // repainter can see, at the pane's own first row.
  const at = (row: number) => Math.max(top + row, HEADER_ROWS);
  return (
    <Box flexDirection="column">
      {item.gap ? <Box height={1} backgroundColor={bridged ? band : undefined} /> : null}
      <Box flexDirection="column" paddingLeft={indent} backgroundColor={wash}>
        <Row
          gutter={gutter}
          tone={item.markerTone}
          accent={accent}
          // A gutterless row's text starts where the marks do, so its cells
          // are measured from there.
          highlight={highlightFor(
            selection,
            at(rows.headline),
            indent + (gutter === '' ? 0 : GUTTER),
          )}
        >
          {item.label ? (
            <Text {...paint(accent ? 'brand' : 'muted', accent)}>{`${item.label}  `}</Text>
          ) : null}
          {item.marker === 'prompt' ? (
            <Mentioned text={item.text} tone={item.tone} agents={agents} />
          ) : (
            <Text {...paint(item.tone)}>{item.text}</Text>
          )}
        </Row>
        {item.lines.map((line, index) => (
          <Row
            key={index}
            indent={DETAIL_INDENT}
            gutter={detailGutter(item.lines, index)}
            tone="muted"
            highlight={highlightFor(
              selection,
              at(rows.details[index] ?? 0),
              indent + DETAIL_INDENT + GUTTER,
            )}
          >
            <Text {...paint(line.tone)}>{line.text}</Text>
          </Row>
        ))}
      </Box>
    </Box>
  );
}

/**
 * The colour a row's text is set in. The hover band is dark enough for the
 * quiet ink to hold on it, so a row reads the same whether or not the pointer
 * is over it — nothing here has to know.
 *
 * An accent stands in for the house brand only — everything a tone says about
 * status stays exactly as loud as it was, so a failed call inside a Gemini
 * task is still red.
 */
function paint(tone: Tone, accent?: string): { color?: string } {
  return { color: accent !== undefined && tone === 'brand' ? accent : COLOUR[tone] };
}

/**
 * A user line with its mentions in colour: every `@name` that resolves to a
 * configured agent wears that agent's own colour, and everything around it
 * keeps the tone the row was given. The same rule as the draft under the
 * prompt, so a line does not change its dress on the way into the transcript.
 */
function Mentioned({
  text,
  tone,
  agents,
}: {
  text: string;
  tone: Tone;
  agents: readonly string[];
}): React.JSX.Element {
  const spans = mentionSpans(text, agents);
  if (spans.length === 0) return <Text {...paint(tone)}>{text}</Text>;
  const chars = [...text];
  const pieces: React.ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) {
      pieces.push(
        <Text key={at} {...paint(tone)}>
          {chars.slice(at, span.start).join('')}
        </Text>,
      );
    }
    pieces.push(
      <Text key={span.start} color={agentColour(span.agent)}>
        {chars.slice(span.start, span.end).join('')}
      </Text>,
    );
    at = span.end;
  }
  if (at < chars.length) {
    pieces.push(
      <Text key={at} {...paint(tone)}>
        {chars.slice(at).join('')}
      </Text>,
    );
  }
  return <Text>{pieces}</Text>;
}

/**
 * A gutter and the text beside it. The gutter is its own fixed-width column so
 * that wrapped text hangs under the first line rather than under the glyph.
 */
function Row({
  gutter,
  tone,
  accent,
  indent = 0,
  highlight,
  children,
}: {
  gutter: string;
  tone: Tone;
  accent?: string;
  indent?: number;
  /**
   * Repaints the selection's wash onto each wrapped line of the text. The
   * gutter stays outside it, the way an editor's glyph column stays outside a
   * selection — it is furniture, and the copy will not carry it either.
   */
  highlight?: (line: string, index: number) => string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box paddingLeft={indent}>
      {/* An empty gutter is no gutter: the text starts where the marks do. */}
      {gutter === '' ? null : (
        <Box flexShrink={0} width={gutter.length + 1}>
          <Text {...paint(tone, accent)}>{gutter}</Text>
        </Box>
      )}
      <Box flexGrow={1}>
        {highlight ? (
          <Transform transform={highlight}>
            <Text wrap="wrap">{children}</Text>
          </Transform>
        ) : (
          <Text wrap="wrap">{children}</Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * The opening frame's greeting: what the transcript stands in for while it is
 * still empty. A hello, a sentence on what handsfree does with a line once it
 * has one, and the shapes a line can take — sat directly on top of the input,
 * so the first thing read is the first thing that can be typed.
 *
 * It is not a transcript row. Nothing here is clickable, selectable or
 * scrollable, and the moment the first record lands the pane goes back to
 * being the transcript — which is why the pane, not this, owns the rows.
 *
 * `rows` is what the pane can spare, and the block is trimmed to it from the
 * bottom up: the sentence about the run goes first, then the examples that
 * matter least. A short window keeps the hello and something to type, rather
 * than the tail of a block whose head has been clipped away.
 */
function Welcome({
  runtime,
  agents,
  rows,
}: {
  runtime: Runtime;
  agents: readonly string[];
  rows: number;
}): React.JSX.Element {
  const examples = openings(runtime, agents);
  // What is left for the sentence about the run and the examples themselves,
  // once the hello, the invitation, the blank rows between them and the margin
  // have all taken theirs. The invitation stays whatever the window does — a
  // list of quotes nobody offered is a list of quotes nobody reads.
  const room = rows - GREETING.length - 1 - 1 - 1 - WELCOME_MARGIN;
  const about = room >= 1 + examples.length;
  const shown = examples.slice(0, Math.max(1, room - (about ? 1 : 0)));
  // A line's width on screen is its own plus the two quotes drawn around it.
  const cells = (line: string): number => columns(line) + 2;
  const width = Math.max(...shown.map(({ line }) => cells(line)));
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={2}
      paddingRight={1}
      paddingBottom={WELCOME_MARGIN}
    >
      {/*
        The hello, the sentence under it and the invitation are all set in the
        terminal's own ink — one voice, handsfree's, saying one thing. The gray
        in this block belongs to the notes beside the examples, which are
        asides about the line they sit next to rather than part of what is
        being said.
      */}
      {GREETING.map((line) => (
        <Text key={line} wrap="truncate">
          {line}
        </Text>
      ))}
      <Box height={1} />
      {about ? <Text wrap="truncate">{ABOUT}</Text> : null}
      <Text wrap="truncate">{INVITATION}</Text>
      <Box height={1} />
      {shown.map(({ line, note }) => (
        <Text key={line} wrap="truncate">
          {/*
            The quotes are the frame around the example, not part of it, so they
            are drawn either side of the line rather than inside it: a mention
            only opens at the start of a word, and a `"` pressed against the `@`
            is exactly what says this one is an email address instead.

            Inside them the line is dressed exactly as the prompt would dress
            it — every mention in its agent's own colour — so an example is
            already the line it is an example of.
          */}
          <Text color={BRAND}>{'"'}</Text>
          <Mentioned text={line} tone="brand" agents={agents} />
          <Text color={BRAND}>{'"'}</Text>
          {/*
            The note is an aside about the line, and it is dressed as one: set
            off far enough to read as its own column, and opened with the mark
            a comment is opened with everywhere else.
          */}
          <Text color={INK}>{`${' '.repeat(width - cells(line) + NOTE_GAP)}// ${note}`}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** The rows of air the greeting keeps between itself and the prompt below it. */
const WELCOME_MARGIN = 2;

/** The columns between the widest example and the column of notes beside them. */
const NOTE_GAP = 4;

/** The hello: the line that greets, and the line that asks. */
const GREETING = ['Hello.', 'What are we working on today?'] as const;

/** The line that hands the examples over, so a list of quotes reads as an offer. */
const INVITATION = 'Try a line like one of these.';

/**
 * What happens to a line once it is sent, in the one sentence worth reading
 * before the first one is: handsfree plans, and hands the work to whoever it
 * suits. It is why a plain request needs no address at all — the first example
 * under it is that sentence made into a line.
 */
const ABOUT =
  'Write it as you would say it; handsfree plans it and picks the agent for it.';

/** One example line as it would be typed, and what that shape of line does. */
interface Opening {
  line: string;
  note: string;
}

/**
 * The examples, spelled with this run's own names rather than with a fixed
 * cast: a plain request, which the planner routes for you; the planner
 * addressed outright; an agent picked by hand; the same with a model behind
 * its colon, taken from the roster it advertised or from the model its launch
 * profile pinned it to; and a command, because the slash is the other thing
 * the prompt answers to. Every one of them is a line that can be sent exactly
 * as it stands — which is also why the last two go first when the window is
 * short and the list has to be cut.
 */
function openings(runtime: Runtime, agents: readonly string[]): readonly Opening[] {
  const first = agents[0] ?? runtime.config.orchestration.acp.agent;
  // A second agent, where the run has one, so the roll's colours are on show
  // in the examples the way they are in the transcript.
  const second = agents[1] ?? first;
  const model = runtime.pool.currentModel(second) ?? runtime.pool.models(second)[0]?.value;
  return [
    { line: 'fix the failing tests', note: 'the planner picks who takes it' },
    { line: `@${ORCHESTRATOR} plan this out`, note: 'call the planner yourself' },
    { line: `@${first} summarise this file`, note: 'straight to an agent' },
    // Only where it says something the row above it did not: one agent, no
    // roster and no pinned model leaves the two lines spelling the same thing.
    ...(model || second !== first
      ? [
          {
            line: `@${model ? `${second}:${model}` : second} write a test first`,
            note: model ? 'name a model after the colon' : 'or to another agent',
          },
        ]
      : []),
    { line: '/agents', note: 'a command · who you can call' },
  ];
}

/**
 * The chat prompt, in the shape Claude Code gives its own: a rule above and a
 * rule below with the pointer and the draft between them, the running turn
 * announced on the line above rather than in place of the input, and the
 * shortcuts sitting under it all.
 *
 * The input never goes away. A turn already running does not take the keyboard
 * with it — what is typed meanwhile is queued, and the count says so.
 *
 * Kept to exactly PROMPT_ROWS rows: the status line above the top rule holds
 * its row whether or not a turn is running, so the transcript above never
 * reflows the moment one starts.
 *
 * The hint line is also where the transcript says it has stopped following the
 * end — scrolled up, what arrives next lands off screen, and only this says so
 * — and where a finished drag says how much of the transcript it copied. At its
 * right edge sits the directory the agents work in, so where a line lands is
 * read on the line it is typed on. The hint keeps its whole line and the path
 * is what gives way, front first: the tail is the part worth keeping.
 *
 * The agents' roll call sits at the right edge of the status line above the
 * input — each agent as the model it is on, a dot per agent, filled while that
 * agent holds an open task — so who is working reads right beside the running
 * turn it belongs to rather than under the shortcuts.
 */
function Prompt({
  draft,
  agents,
  status,
  startedAt,
  queued,
  allOpen,
  following,
  copied,
  cwd,
}: {
  draft: Draft;
  agents: readonly string[];
  status: readonly AgentStatusEntry[];
  startedAt: number | undefined;
  queued: number;
  allOpen: boolean;
  following: boolean;
  copied: number | undefined;
  /** The directory the agents work in, drawn at the hint line's right edge. */
  cwd: string;
}): React.JSX.Element {
  // Where debug lines are going, when they are going anywhere. It cannot
  // change while the UI is up, so reading it at render is enough.
  const debugTo = debugDestination();
  const busy = startedAt !== undefined;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box height={1} paddingLeft={2} paddingRight={1} justifyContent="space-between" gap={2}>
        <Box>{busy ? <Working startedAt={startedAt} queued={queued} /> : null}</Box>
        <AgentStatus status={status} />
      </Box>
      <Box
        width="100%"
        borderStyle="round"
        borderColor={RULE_INK}
        borderLeft={false}
        borderRight={false}
        // The pointer opens the line: nothing sits to the left of it, so the
        // draft starts where the rules above and below it start.
        paddingRight={1}
      >
        <Text color={busy ? INK_FAINT : INK}>{`${PROMPT_CHAR} `}</Text>
        <Box flexGrow={1}>
          <DraftLine draft={draft} agents={agents} />
        </Box>
      </Box>
      <Box paddingLeft={2} paddingRight={1} justifyContent="space-between" gap={2}>
        <Box flexShrink={0}>
          <Text color={INK} wrap="truncate">
            {copied !== undefined
              ? `copied ${copied} line${copied === 1 ? '' : 's'} to the clipboard`
              : !following
                ? 'scrolled up · page down or the wheel to follow again'
                : busy
                  ? `esc to interrupt · ctrl+o to ${allOpen ? 'collapse' : 'expand'} all`
                  : `/ for commands · @ for agents · ctrl+o to ${allOpen ? 'collapse' : 'expand'} all · /exit`}
          </Text>
        </Box>
        <Box gap={2}>
          {/* On the rare run with debug on, that notice keeps its whole line
              too — it is why the run was started this way. */}
          {debugTo ? (
            <Box flexShrink={0}>
              <Text color="yellow" wrap="truncate-start">
                ● debug → {tildify(debugTo)}
              </Text>
            </Box>
          ) : null}
          <Text color={INK} wrap="truncate-start">
            {tildify(cwd)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** One agent as the status line tells it: who, what to call them, and whether they are working. */
interface AgentStatusEntry {
  id: string;
  /** The model the agent is on, or its id when the profile names none. */
  label: string;
  busy: boolean;
  /**
   * The planner rather than an agent: drawn as a diamond, and first in the
   * roll. Its `id` is still the agent it plans through, so its mark wears that
   * agent's colour — the same agent may also stand in the roll on its own,
   * working a task in a session of its own, and the two are different things.
   */
  planner?: true;
}

/**
 * The orchestration model as the roll tells it: which agent is planning and on
 * what, spelled the way the mention that moves it is — `claude:haiku`. A local
 * endpoint has no agent to name, so it is the model id alone. Read off the
 * config every render rather than remembered, because that is where
 * `@orchestrator:agent:model` writes what it moved.
 */
function plannerStatus(config: Config, busy: boolean): AgentStatusEntry {
  const { orchestration } = config;
  if (orchestration.provider !== 'acp') {
    return { id: ORCHESTRATOR, label: orchestration.local.model, busy, planner: true };
  }
  const agent = orchestration.acp.agent;
  const on = orchestrationModel(config);
  return { id: agent, label: on ? `${agent}:${on}` : agent, busy, planner: true };
}

/**
 * The roll call at the status line's right edge, directly above the input: a
 * dot per enabled agent, filled
 * and full-strength while that agent holds an open task, outlined and dimmed
 * while it sits idle. The dot spends the agent's own colour — the same one its
 * mentions and its task blocks wear — so who is working reads before any label.
 */
function AgentStatus({ status }: { status: readonly AgentStatusEntry[] }): React.JSX.Element {
  return (
    <Text wrap="truncate">
      {status.map((agent, index) => (
        <Text key={agent.planner ? `planner:${agent.id}` : agent.id}>
          {index > 0 ? (
            <Text color={INK_FAINT}>{' · '}</Text>
          ) : null}
          <Text color={agentColour(agent.id)} dimColor={!agent.busy}>
            {agent.planner
              ? agent.busy
                ? PLAN_BUSY
                : PLAN_IDLE
              : agent.busy
                ? DOT_BUSY
                : DOT_IDLE}
          </Text>
          <Text color={agent.busy ? INK : INK_FAINT}>{` ${agent.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

/**
 * The commands a half-written line could still become, drawn above the prompt
 * rather than in place of it — unlike `Ask`, which takes the keyboard with it.
 * The prompt stays live the whole time: this is a hint, not a mode.
 *
 * Every suggestion is exactly one screen row. A description that wrapped would
 * grow the frame by a line, and the frame is a fixed height — ink would answer
 * by scrolling the whole UI.
 */
function Suggestions({
  items,
  selected,
}: {
  items: readonly MenuItem[];
  selected: number;
}): React.JSX.Element {
  const width = Math.max(...items.map((item) => menuLabel(item).length)) + 1;
  return (
    // The transcript's pane already gave up these rows, so the menu keeps every
    // one of them rather than being squeezed back into the prompt.
    <Box flexDirection="column" flexShrink={0} marginTop={1}>
      {items.map((item, index) => {
        const chosen = index === Math.min(selected, items.length - 1);
        // An agent's name keeps its own colour whether or not it is chosen —
        // the colour is what the menu is teaching — so being chosen shows as
        // weight instead, and a model row borrows the colour of the agent it
        // belongs to. A command row is set in the header name's own light
        // when chosen — full ink and bold — and steps down to the path's gray
        // otherwise, so the selection reads at a glance.
        const colour =
          item.kind === 'agent'
            ? agentColour(item.id)
            : item.kind === 'model'
              ? agentColour(item.agent)
              : chosen
                ? undefined
                : INK;
        // A model is described in the agent's own words and no others: the id
        // it advertised on the left, the blurb it wrote on the right. Its
        // display name is not folded in — that read as handsfree renaming it.
        const note =
          item.kind === 'command'
            ? item.command.description
            : item.kind === 'agent'
              ? item.note
              : (item.choice.description ?? '');
        return (
          <Box key={menuLabel(item)} paddingLeft={2}>
            <Text wrap="truncate">
              <Text color={colour} bold={chosen}>
                {menuLabel(item).padEnd(width)}
              </Text>
              <Text color={INK_FAINT}>
                {item.kind === 'command' && item.command.argumentHint
                  ? `${item.command.argumentHint}  `
                  : ''}
                {note}
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * The menu's line for when it has no rows: why the list is empty, standing in
 * the column the suggestions would have used. It is drawn, not offered — the
 * keymap never sees it, so nothing selects it and enter still sends the line.
 */
function MenuNote({ text }: { text: string }): React.JSX.Element {
  return (
    <Box flexShrink={0} marginTop={1} paddingLeft={2}>
      <Text color="gray" dimColor wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}

/**
 * The draft with its cursor drawn in: the code point under the cursor is
 * inverted, and a cursor at the end inverts the space one past the text.
 *
 * A completed mention wears its agent's colour as it is typed, the same
 * colour the header roster and the task blocks spend on that agent. The
 * colouring and the cursor have to be composed rather than layered — the
 * inverted cell is a piece of its own, so a cursor sitting inside a mention
 * splits the colour around itself instead of losing it.
 */
function DraftLine({ draft, agents }: { draft: Draft; agents: readonly string[] }): React.JSX.Element {
  const spans = mentionSpans(draft.value, agents);
  // A cursor at the end rests on a space one past the text; the virtual cell
  // joins the array so one loop draws every cursor position the same way.
  const chars = [...draft.value];
  if (draft.cursor >= chars.length) chars.push(' ');
  const colourAt = (index: number): string | undefined => {
    const span = spans.find((s) => index >= s.start && index < s.end);
    return span ? agentColour(span.agent) : undefined;
  };
  const pieces: { text: string; colour: string | undefined; inverse: boolean }[] = [];
  for (const [index, char] of chars.entries()) {
    const colour = colourAt(index);
    const inverse = index === draft.cursor;
    const last = pieces[pieces.length - 1];
    if (last && last.colour === colour && last.inverse === inverse && !inverse) last.text += char;
    else pieces.push({ text: char, colour, inverse });
  }
  return (
    <Text>
      {pieces.map((piece, index) => (
        <Text key={index} color={piece.colour} inverse={piece.inverse}>
          {piece.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * The line that says a turn is running: the spinner, the word with a glint
 * travelling across it, how long it has been going and how much is waiting
 * behind it. The frame interval is also what advances the clock, so it has to
 * be well under a second.
 *
 * The shimmer runs off the wall clock rather than off the frame count, so its
 * step and the spinner's stay independent of each other; one timer is enough
 * to redraw both because it ticks faster than either of them moves.
 */
function Working({ startedAt, queued }: { startedAt: number; queued: number }): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => n + 1), 120);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();
  const facts = [elapsed(now - startedAt), ...(queued > 0 ? [`${queued} queued`] : [])];
  const { before, band, after } = shimmer('Working…', Math.floor(now / SHIMMER_STEP_MS));
  return (
    <Text wrap="truncate">
      <Text color={BRAND}>{SPINNER[frame % SPINNER.length]}</Text>
      <Text color={BRAND}>{` ${before}`}</Text>
      <Text color={SHIMMER}>{band}</Text>
      <Text color={BRAND}>{after}</Text>
      <Text color={INK}>{` (${facts.join(' · ')})`}</Text>
    </Text>
  );
}

/** How long a turn has been running, in the units it has earned. */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function Ask({ ask }: { ask: Extract<Question, { kind: 'ask' }> }): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text>
        <Text color={agentColour(ask.agentId)} bold>
          {ask.agentId}
        </Text>{' '}
        wants to {ask.summary}
      </Text>
      {ask.detail ? <Text color={INK}>{ask.detail}</Text> : null}
      <Text color={INK}>
        rule: {ask.rule}
      </Text>
      <Box marginTop={1}>
        <Text>
          <Text color="green">y</Text> <Text color={INK}>allow once</Text>
          <Text color={INK_FAINT}>{'   ·   '}</Text>
          <Text color="red">n</Text> <Text color={INK}>refuse</Text>
        </Text>
      </Box>
    </Box>
  );
}

/**
 * A form opens on its first field, carrying whatever default the agent
 * suggested — so Enter alone is the answer the agent expected, and typing over
 * it is the answer it did not.
 */
function blankForm(fields: readonly InputField[]): FormState {
  return {
    index: 0,
    values: {},
    buffer: openingBuffer(fields[0]),
    chosen: openingChoice(fields[0]),
    error: undefined,
  };
}

function openingBuffer(field: InputField | undefined): string {
  if (!field || field.default === undefined) return '';
  if (field.kind === 'string' || field.kind === 'number' || field.kind === 'integer') {
    return String(field.default);
  }
  return '';
}

function openingChoice(field: InputField | undefined): readonly string[] {
  return field?.kind === 'multiselect' && Array.isArray(field.default) ? field.default : [];
}

/** What a keypress does to the form; `done` closes it with the whole answer. */
type Typed =
  | { done: false; state: FormState }
  | { done: true; values: Record<string, InputValue> };

/**
 * One keypress against the field being filled. Every field kind is answered by
 * something a terminal can send without a mouse: a digit for a choice, y or n
 * for a boolean, typed text for the rest, and Enter to move on. Nothing here
 * can skip a required field, because a form returned half-filled is worse for
 * the agent than one it never got.
 */
function typed(
  fields: readonly InputField[],
  state: FormState,
  field: InputField,
  char: string,
  key: { return?: boolean; backspace?: boolean; delete?: boolean },
): Typed {
  const advance = (value: InputValue | undefined): Typed => {
    const values =
      value === undefined ? { ...state.values } : { ...state.values, [field.key]: value };
    const index = state.index + 1;
    if (index >= fields.length) return { done: true, values };
    return {
      done: false,
      state: {
        index,
        values,
        buffer: openingBuffer(fields[index]),
        chosen: openingChoice(fields[index]),
        error: undefined,
      },
    };
  };
  const stay = (error?: string): Typed => ({ done: false, state: { ...state, error } });

  switch (field.kind) {
    case 'boolean':
      if (char === 'y' || char === 'Y') return advance(true);
      if (char === 'n' || char === 'N') return advance(false);
      if (key.return && typeof field.default === 'boolean') return advance(field.default);
      if (key.return && !field.required) return advance(undefined);
      return stay(key.return ? 'y or n' : state.error);

    case 'enum': {
      const picked = numbered(char, field.options?.length ?? 0);
      if (picked !== undefined) return advance(field.options![picked]!.value);
      if (key.return) {
        if (typeof field.default === 'string') return advance(field.default);
        if (!field.required) return advance(undefined);
        return stay('pick one');
      }
      return stay(state.error);
    }

    case 'multiselect': {
      const picked = numbered(char, field.options?.length ?? 0);
      if (picked !== undefined) {
        const value = field.options![picked]!.value;
        const chosen = state.chosen.includes(value)
          ? state.chosen.filter((entry) => entry !== value)
          : [...state.chosen, value];
        return { done: false, state: { ...state, chosen, error: undefined } };
      }
      if (key.return) {
        if (state.chosen.length === 0 && field.required) return stay('pick at least one');
        return advance(state.chosen.length === 0 ? undefined : [...state.chosen]);
      }
      return stay(state.error);
    }

    default: {
      if (key.return) {
        const text = state.buffer.trim();
        if (text === '') {
          if (field.required) return stay('this one is needed');
          return advance(undefined);
        }
        if (field.kind === 'string') return advance(text);
        const number = Number(text);
        if (!Number.isFinite(number)) return stay('a number, please');
        if (field.kind === 'integer' && !Number.isInteger(number)) return stay('a whole number');
        return advance(number);
      }
      if (key.backspace || key.delete) {
        return {
          done: false,
          state: { ...state, buffer: [...state.buffer].slice(0, -1).join(''), error: undefined },
        };
      }
      // Control bytes are not text: an arrow key arrives as an escape sequence
      // and would otherwise be typed into the answer.
      const printable = [...char].filter((glyph) => glyph >= ' ' && glyph !== '').join('');
      if (printable === '') return stay(state.error);
      return {
        done: false,
        state: { ...state, buffer: state.buffer + printable, error: undefined },
      };
    }
  }
}

/** `1`–`9` as an index into a list of that many options. */
function numbered(char: string, length: number): number | undefined {
  if (char.length !== 1 || char < '1' || char > '9') return undefined;
  const index = Number(char) - 1;
  return index < length ? index : undefined;
}

/**
 * An agent that stopped to ask something, and the field it is waiting on. The
 * fields already answered stay on screen: what the agent is being told is as
 * much a part of the question as what it asked.
 */
function Elicit({
  question,
  form,
}: {
  question: Extract<Question, { kind: 'input' }>;
  form: FormState | undefined;
}): React.JSX.Element {
  const state = form ?? blankForm(question.fields);
  const field = question.fields[state.index];

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text>
        <Text color={agentColour(question.agentId)} bold>
          {question.agentId}
        </Text>{' '}
        asks: {question.summary}
      </Text>

      {question.fields.slice(0, state.index).map((answered) => (
        <Text key={answered.key} color={INK}>
          {`${answered.label}: ${said(state.values[answered.key])}`}
        </Text>
      ))}

      {field ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {field.label}
            {field.required ? '' : ' (optional)'}
          </Text>
          {field.description ? <Text color={INK}>{field.description}</Text> : null}
          {field.options?.map((option, index) => (
            <Text key={option.value} color={INK}>
              {`  ${index + 1}) ${
                field.kind === 'multiselect'
                  ? `${state.chosen.includes(option.value) ? '×' : ' '} `
                  : ''
              }${option.label}`}
            </Text>
          ))}
          {field.kind === 'string' || field.kind === 'number' || field.kind === 'integer' ? (
            <Text>
              <Text color={INK_FAINT}>{`${PROMPT_CHAR} `}</Text>
              {state.buffer}
              <Text color={INK_FAINT}>▏</Text>
            </Text>
          ) : null}
          {state.error ? <Text color="red">{state.error}</Text> : null}
          <Box marginTop={1}>
            <Text>
              <Text color={INK}>{hint(field)}</Text>
              <Text color={INK_FAINT}>{'   ·   '}</Text>
              <Text color="red">esc</Text> <Text color={INK}>refuse to answer</Text>
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function hint(field: InputField): string {
  switch (field.kind) {
    case 'boolean':
      return 'y / n';
    case 'enum':
      return 'a number to pick';
    case 'multiselect':
      return 'numbers to toggle · enter when done';
    default:
      return 'type, then enter';
  }
}

function said(value: InputValue | undefined): string {
  if (value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/**
 * The glyph a continuation line sits behind. A brief wears the bullet the
 * agent's rows wear, since it is set among them; the first result line wears
 * the result mark, and the rest hang under it.
 */
function detailGutter(lines: readonly ViewLine[], index: number): string {
  const line = lines[index]!;
  if (line.kind === 'brief') return GLYPH.bullet;
  const firstResult = lines.findIndex((entry) => entry.kind !== 'brief');
  return index === firstResult ? RESULT_GUTTER : RESULT_INDENT;
}

/**
 * The agents that came back on a session from before, on the header's roster
 * line: a run reopened with `--run` is one where the agents remember what
 * this process has not seen, and that is worth a word where the roster is —
 * not a row in the conversation, where nothing happened.
 */
function resumedLine(resumed: string[]): string {
  return resumed.length === 0 ? '' : ` · resumed ${resumed.join(', ')}`;
}

function tildify(dir: string): string {
  const home = os.homedir();
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}
