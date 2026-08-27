import os from 'node:os';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Runtime } from '../../runtime.js';
import { debugDestination } from '../../debug.js';
import { buildView, type Tone, type ViewItem } from '../view-model.js';
import { itemAt, lastFitting, placeItems } from './layout.js';
import { CURSOR_QUERY, isMouseReport, parseCursorReport, parseMouseEvent, trackMouse } from './mouse.js';
import {
  agentColour,
  BAND,
  BRAND,
  COLOUR,
  GLYPH,
  HEADER_INK,
  MASCOT,
  MASCOT_BLINK,
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
 * Rows above the transcript: the welcome mark's three rows and the blank row
 * on either side of it. The mark never wraps, so this stays a constant a
 * click's row can be measured against.
 */
const HEADER_ROWS = 5;

/**
 * Rows below it: the status line, the prompt's two rules with its input between
 * them, and the hint. The status line is always drawn — blank when nothing is
 * running — so the transcript's budget never changes as a turn starts.
 */
const PROMPT_ROWS = 5;

interface PendingAsk {
  summary: string;
  detail: string;
  rule: string;
  agentId: string;
  answer: (allowed: boolean) => void;
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
  const applyDraft = (update: (d: Draft) => Draft) => {
    draftRef.current = update(draftRef.current);
    setDraft(draftRef.current);
  };
  const [startedAt, setStartedAt] = useState<number | undefined>();
  // Typed while a turn was running. The prompt stays open the whole time, so
  // what is entered has to go somewhere; it goes here and leaves in order once
  // the turn that was in the way finishes.
  const [queued, setQueued] = useState<readonly string[]>([]);
  const [ask, setAsk] = useState<PendingAsk | undefined>();
  const [openTasks, setOpenTasks] = useState<ReadonlySet<number>>(() => new Set());
  const [hoveredTask, setHoveredTask] = useState<number | undefined>();
  const pending = useRef<PendingAsk[]>([]);
  const busy = startedAt !== undefined;

  // Reporting has to be turned back off, or the terminal keeps sending drags
  // here instead of selecting text long after handsfree has exited.
  useEffect(() => trackMouse(stdout), [stdout]);

  // The transcript is the model; the view is a pure function of it.
  useEffect(() => {
    const render = () =>
      setItems(
        buildView(runtime.transcript.all(), runtime.workspace.dir, {
          expandedTasks: openTasks,
          expandHint: EXPAND_HINT,
        }),
      );
    render();
    runtime.transcript.on('record', render);
    return () => {
      runtime.transcript.off('record', render);
    };
  }, [runtime, openTasks]);

  // Being here is what turns an `ask` verdict into a real question. Without a
  // mounted UI the policy engine denies instead of waiting.
  useEffect(() => {
    runtime.setEscalator({
      ask: (question) =>
        new Promise<boolean>((resolve) => {
          const entry: PendingAsk = {
            summary: question.summary,
            detail: question.detail,
            rule: question.rule,
            agentId: question.context.agentId,
            answer: (allowed) => {
              resolve(allowed);
              const next = pending.current.shift();
              setAsk(next);
            },
          };
          question.signal.addEventListener('abort', () => entry.answer(false), { once: true });
          setAsk((current) => {
            if (current) {
              pending.current.push(entry);
              return current;
            }
            return entry;
          });
        }),
    });
    return () => runtime.setEscalator(undefined);
  }, [runtime]);

  const rows = stdout?.rows ?? 30;
  const columns = stdout?.columns ?? 80;
  // The first visible row sits against the header, so it keeps its own space
  // rather than inheriting the gap it would have had mid-scroll. Placement and
  // rendering share the result, or a click would be measured against a
  // different frame than the one on screen.
  const shown = useMemo(() => {
    const fitting = lastFitting(items, Math.max(rows - 1 - HEADER_ROWS - PROMPT_ROWS, 8), columns);
    return fitting.map((item, index) => (index === 0 && item.gap ? { ...item, gap: false } : item));
  }, [items, rows, columns]);
  const placements = useMemo(() => placeItems(shown, columns, HEADER_ROWS), [shown, columns]);

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

  const start = (text: string) => {
    if (text === '/reset') {
      runtime.conversation.reset();
      return;
    }
    setStartedAt(Date.now());
    void runtime.conversation.send(text).finally(() => setStartedAt(undefined));
  };

  const submit = (text: string) => {
    const trimmed = text.trim();
    applyDraft(() => ({ value: '', cursor: 0 }));
    if (trimmed === '/quit' || trimmed === '/exit') {
      // Close, not cancel: cancel would still summarise the turn, and that
      // request would keep the process alive after the UI is gone.
      void runtime.conversation.close();
      exit();
      return;
    }
    if (trimmed === '') return;
    // Leaving is the only thing that cannot wait; everything else the user
    // sends mid-turn takes its place in line behind the turn already running.
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
    if (isMouseReport(char)) {
      const mouse = parseMouseEvent(char);
      if (!mouse) return;
      const top = frameTop.current ?? (stdout?.isTTY ? 1 : 0);
      const taskId = itemAt(layout.current, mouse.row - top)?.taskId;
      if (mouse.type === 'hover') {
        setHoveredTask(taskId);
      } else if (taskId !== undefined) {
        toggleTask(taskId);
      }
      return;
    }
    if (ask) {
      if (char === 'y' || char === 'Y') ask.answer(true);
      if (char === 'n' || char === 'N' || key.escape) ask.answer(false);
      return;
    }
    // Folded tasks are still in the transcript; this is the way back to all of
    // them at once, where a click opens the one it landed on.
    if (key.ctrl && char === 'o') {
      setOpenTasks(allOpen ? new Set() : new Set(tasks));
      return;
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
  // the spacer below the transcript is what pushes the prompt to the bottom,
  // the way Claude Code's chat sits under its welcome mark.
  return (
    <Box flexDirection="column" height={rows - 1}>
      <Header runtime={runtime} />

      <Box flexDirection="column">
        {shown.map((item, index) => {
          const hovered = hoveredTask !== undefined && item.taskId === hoveredTask;
          const opened = item.taskId !== undefined && openTasks.has(item.taskId);
          const band = hovered ? 'gray' : opened ? BAND : undefined;
          return (
            <Entry
              key={item.key}
              item={item}
              band={band}
              hovered={hovered}
              bridged={band !== undefined && shown[index - 1]?.taskId === item.taskId}
            />
          );
        })}
      </Box>

      <Box flexGrow={1} />

      {ask ? (
        <Ask ask={ask} />
      ) : (
        <Prompt draft={draft} startedAt={startedAt} queued={queued.length} allOpen={allOpen} />
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
 * The welcome mark, in the shape Claude Code opens with: the condensed logo on
 * the left and three facts beside it — what this is, what is answering, and
 * where it is running. No box and no tips column; the shortcuts already live
 * under the prompt. A blank row and a column of air sit on every side of it.
 *
 * Kept to exactly HEADER_ROWS rows — that constant is what a click's row is
 * measured against — so every line truncates rather than wraps, and the tail
 * of the path is the part worth keeping.
 */
function Header({ runtime }: { runtime: Runtime }): React.JSX.Element {
  const mascot = useBlink() ? MASCOT_BLINK : MASCOT;
  const agents = Object.entries(runtime.config.agents)
    .filter(([, profile]) => profile.enabled)
    .map(([id]) => id);
  const orchestration = runtime.config.orchestration;
  const brain =
    orchestration.provider === 'acp'
      ? `${orchestration.acp.agent} (acp)`
      : orchestration.local.model;
  return (
    <Box margin={1} gap={2}>
      <Box flexDirection="column" flexShrink={0}>
        {mascot.map((line, index) => (
          <Text key={index} color={BRAND}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        <Text wrap="truncate">
          <Text bold>handsfree</Text>
          <Text color={HEADER_INK}>{` v${VERSION}`}</Text>
        </Text>
        <Text color={HEADER_INK} wrap="truncate">
          {`${brain} · `}
          {agents.map((id, index) => (
            <Text key={id}>
              {index > 0 ? ', ' : ''}
              <Text color={agentColour(id)}>{id}</Text>
            </Text>
          ))}
        </Text>
        <Text color={HEADER_INK} wrap="truncate-start">
          {tildify(runtime.workspace.dir)}
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
  hovered,
  bridged,
}: {
  item: ViewItem;
  band: string | undefined;
  hovered: boolean;
  bridged: boolean;
}): React.JSX.Element {
  const accent = item.agentId ? agentColour(item.agentId) : undefined;
  return (
    <Box flexDirection="column">
      {item.gap ? <Box height={1} backgroundColor={bridged ? band : undefined} /> : null}
      <Box flexDirection="column" paddingLeft={item.depth * 2} backgroundColor={band}>
        <Row gutter={GLYPH[item.marker]} tone={item.markerTone} accent={accent} hovered={hovered}>
          {item.label ? (
            <Text {...paint(accent ? 'brand' : 'muted', hovered, accent)}>{`${item.label}  `}</Text>
          ) : null}
          <Text {...paint(item.tone, hovered)}>{item.text}</Text>
        </Row>
        {item.lines.map((line, index) => (
          <Row
            key={index}
            indent={2}
            gutter={index === 0 ? RESULT_GUTTER : RESULT_INDENT}
            tone="muted"
            hovered={hovered}
          >
            <Text {...paint(line.tone, hovered)}>{line.text}</Text>
          </Row>
        ))}
      </Box>
    </Box>
  );
}

/**
 * Gray text on the gray hover band would vanish, so a hovered row keeps its
 * muted lines readable by dimming the terminal's default ink instead.
 *
 * An accent stands in for the house brand only — everything a tone says about
 * status stays exactly as loud as it was, so a failed call inside a Gemini
 * task is still red.
 */
function paint(
  tone: Tone,
  hovered: boolean,
  accent?: string,
): { color?: string; dimColor?: boolean } {
  const colour = accent !== undefined && tone === 'brand' ? accent : COLOUR[tone];
  if (hovered && colour === 'gray') return { dimColor: true };
  return { color: colour };
}

/**
 * A gutter and the text beside it. The gutter is its own fixed-width column so
 * that wrapped text hangs under the first line rather than under the glyph.
 */
function Row({
  gutter,
  tone,
  hovered,
  accent,
  indent = 0,
  children,
}: {
  gutter: string;
  tone: Tone;
  hovered: boolean;
  accent?: string;
  indent?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box paddingLeft={indent}>
      <Box flexShrink={0} width={gutter.length + 1}>
        <Text {...paint(tone, hovered, accent)}>{gutter}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{children}</Text>
      </Box>
    </Box>
  );
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
 */
function Prompt({
  draft,
  startedAt,
  queued,
  allOpen,
}: {
  draft: Draft;
  startedAt: number | undefined;
  queued: number;
  allOpen: boolean;
}): React.JSX.Element {
  // Where debug lines are going, when they are going anywhere. It cannot
  // change while the UI is up, so reading it at render is enough.
  const debugTo = debugDestination();
  const busy = startedAt !== undefined;
  return (
    <Box flexDirection="column">
      <Box height={1} paddingX={2}>
        {busy ? <Working startedAt={startedAt} queued={queued} /> : null}
      </Box>
      <Box
        width="100%"
        borderStyle="round"
        borderColor={RULE_INK}
        borderDimColor={busy}
        borderLeft={false}
        borderRight={false}
        // The pointer opens the line: nothing sits to the left of it, so the
        // draft starts where the rules above and below it start.
        paddingRight={1}
      >
        <Text color="gray" dimColor={busy}>
          {`${PROMPT_CHAR} `}
        </Text>
        <Box flexGrow={1}>
          <DraftLine draft={draft} />
        </Box>
      </Box>
      <Box paddingLeft={2} paddingRight={1} justifyContent="space-between" gap={2}>
        <Text color="gray" dimColor wrap="truncate">
          {busy
            ? `esc to interrupt · ctrl+o to ${allOpen ? 'collapse' : 'expand'} all`
            : `click a task · ctrl+o to ${allOpen ? 'collapse' : 'expand'} all · /quit`}
        </Text>
        {debugTo ? (
          <Text color="yellow" wrap="truncate-start">
            ● debug → {tildify(debugTo)}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

/**
 * The draft with its cursor drawn in: the code point under the cursor is
 * inverted, and a cursor at the end inverts the space one past the text.
 */
function DraftLine({ draft }: { draft: Draft }): React.JSX.Element {
  const chars = [...draft.value];
  const before = chars.slice(0, draft.cursor).join('');
  const under = chars[draft.cursor] ?? ' ';
  const after = chars.slice(draft.cursor + 1).join('');
  return (
    <Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
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
      <Text color="gray" dimColor>{` (${facts.join(' · ')})`}</Text>
    </Text>
  );
}

/** How long a turn has been running, in the units it has earned. */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function Ask({ ask }: { ask: PendingAsk }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        <Text color={agentColour(ask.agentId)} bold>
          {ask.agentId}
        </Text>{' '}
        wants to {ask.summary}
      </Text>
      {ask.detail ? <Text color="gray">{ask.detail}</Text> : null}
      <Text color="gray" dimColor>
        rule: {ask.rule}
      </Text>
      <Box marginTop={1}>
        <Text>
          <Text color="green">y</Text> <Text color="gray">allow once</Text>
          <Text color="gray" dimColor>{'   ·   '}</Text>
          <Text color="red">n</Text> <Text color="gray">refuse</Text>
        </Text>
      </Box>
    </Box>
  );
}

function tildify(dir: string): string {
  const home = os.homedir();
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}
