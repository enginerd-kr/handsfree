import os from 'node:os';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Runtime } from '../../runtime.js';
import { buildView, type Tone, type ViewItem } from '../view-model.js';
import { itemAt, lastFitting, placeItems } from './layout.js';
import { CURSOR_QUERY, isMouseReport, parseCursorReport, parseMouseEvent, trackMouse } from './mouse.js';
import { BAND, BRAND, COLOUR, GLYPH, RESULT_GUTTER, RESULT_INDENT, SPINNER } from './theme.js';

const EXPAND_HINT = 'click or ctrl+o to expand';

/** Rows above the transcript: the header line and the blank one under it. */
const HEADER_ROWS = 2;

/** Rows below it: the prompt's blank line, its bordered box, and the hint. */
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
  const [startedAt, setStartedAt] = useState<number | undefined>();
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
    const fitting = lastFitting(items, Math.max(rows - 9, 8), columns);
    return fitting.map((item, index) => (index === 0 && item.gap ? { ...item, gap: false } : item));
  }, [items, rows, columns]);
  const placements = useMemo(() => placeItems(shown, columns, HEADER_ROWS), [shown, columns]);

  const tasks = useMemo(
    () => new Set(shown.map((item) => item.taskId).filter((id) => id !== undefined)),
    [shown],
  );
  const allOpen = tasks.size > 0 && [...tasks].every((id) => openTasks.has(id));
  // Mouse rows are screen rows, but the frame starts wherever the shell prompt
  // left it and drifts up once output reaches the bottom of the window — so
  // where it sits is measured, not assumed. After each layout settles the
  // terminal is asked where its cursor is; Ink parks it on the line under the
  // frame, so the answer minus the frame's height is the frame's first row.
  // Until the first answer lands, clicks assume a fresh terminal: the frame
  // immediately below the command that launched us.
  const frameTop = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!stdout?.isTTY || ask) return;
    // Past Ink's render throttle, so the answer describes this frame.
    const timer = setTimeout(() => stdout.write(CURSOR_QUERY), 80);
    return () => clearTimeout(timer);
  }, [stdout, placements, ask]);

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

  const submit = (text: string) => {
    const trimmed = text.trim();
    setDraft({ value: '', cursor: 0 });
    if (trimmed === '' || busy) return;
    if (trimmed === '/quit' || trimmed === '/exit') {
      exit();
      return;
    }
    if (trimmed === '/reset') {
      runtime.conversation.reset();
      return;
    }
    setStartedAt(Date.now());
    void runtime.conversation.send(trimmed).finally(() => setStartedAt(undefined));
  };

  // The prompt is edited here, not by a text-input component. A second
  // component would keep its own cursor state and see every keypress this
  // handler sees — including the mouse and cursor reports above — and there is
  // no way to stop Ink handing it a report it would type into the value.
  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      runtime.conversation.cancel();
      exit();
      return;
    }
    const cursorRow = parseCursorReport(char);
    if (cursorRow !== undefined) {
      // The answer describes the frame the terminal had when it replied; while
      // an ask is up the footer is not the prompt, so the height would lie.
      if (!ask) {
        const transcript = layout.current;
        const bottom = transcript[transcript.length - 1]?.bottom ?? HEADER_ROWS;
        frameTop.current = Math.max(0, cursorRow - (bottom + PROMPT_ROWS));
      }
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
      if (busy) runtime.conversation.cancel();
      return;
    }
    // While a turn runs the prompt is off screen, so nothing below applies.
    if (busy) return;
    if (key.return) {
      submit(draft.value);
      return;
    }
    if (key.leftArrow) {
      setDraft((d) => ({ ...d, cursor: Math.max(0, d.cursor - 1) }));
      return;
    }
    if (key.rightArrow) {
      setDraft((d) => ({ ...d, cursor: Math.min([...d.value].length, d.cursor + 1) }));
      return;
    }
    if (key.home || (key.ctrl && char === 'a')) {
      setDraft((d) => ({ ...d, cursor: 0 }));
      return;
    }
    if (key.end || (key.ctrl && char === 'e')) {
      setDraft((d) => ({ ...d, cursor: [...d.value].length }));
      return;
    }
    if (key.backspace) {
      setDraft((d) => {
        if (d.cursor === 0) return d;
        const chars = [...d.value];
        chars.splice(d.cursor - 1, 1);
        return { value: chars.join(''), cursor: d.cursor - 1 };
      });
      return;
    }
    // Forward delete: fn+delete on a Mac keyboard, the Delete key elsewhere.
    if (key.delete) {
      setDraft((d) => {
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
    setDraft((d) => {
      const chars = [...d.value];
      const typed = [...char];
      chars.splice(d.cursor, 0, ...typed);
      return { value: chars.join(''), cursor: d.cursor + typed.length };
    });
  });

  return (
    <Box flexDirection="column">
      {/* Kept to exactly one row: HEADER_ROWS is what a click's row is measured
          against, so a workspace path long enough to wrap would aim every click
          two lines off. The tail of the path is the part worth keeping. */}
      <Box marginBottom={1}>
        <Box flexShrink={0}>
          <Text color={BRAND}>✻ </Text>
          <Text bold>handsfree</Text>
        </Box>
        <Box flexShrink={1} paddingLeft={2}>
          <Text color="gray" wrap="truncate-start">
            {tildify(runtime.workspace.dir)}
          </Text>
        </Box>
      </Box>

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

      {ask ? (
        <Ask ask={ask} />
      ) : (
        <Prompt draft={draft} startedAt={startedAt} allOpen={allOpen} />
      )}
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
  return (
    <Box flexDirection="column">
      {item.gap ? <Box height={1} backgroundColor={bridged ? band : undefined} /> : null}
      <Box flexDirection="column" paddingLeft={item.depth * 2} backgroundColor={band}>
        <Row gutter={GLYPH[item.marker]} tone={item.markerTone} hovered={hovered}>
          {item.label ? <Text {...paint('muted', hovered)}>{`${item.label}  `}</Text> : null}
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
 */
function paint(tone: Tone, hovered: boolean): { color?: string; dimColor?: boolean } {
  const colour = COLOUR[tone];
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
  indent = 0,
  children,
}: {
  gutter: string;
  tone: Tone;
  hovered: boolean;
  indent?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box paddingLeft={indent}>
      <Box flexShrink={0} width={gutter.length + 1}>
        <Text {...paint(tone, hovered)}>{gutter}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{children}</Text>
      </Box>
    </Box>
  );
}

function Prompt({
  draft,
  startedAt,
  allOpen,
}: {
  draft: Draft;
  startedAt: number | undefined;
  allOpen: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={startedAt === undefined ? BRAND : 'gray'} paddingX={1}>
        {startedAt === undefined ? (
          <>
            <Text color="gray">{'> '}</Text>
            <DraftLine draft={draft} />
          </>
        ) : (
          <Working startedAt={startedAt} />
        )}
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray" dimColor>
          {startedAt === undefined
            ? `click a task · ctrl+o to ${allOpen ? 'collapse' : 'expand'} all · /quit`
            : 'esc to interrupt'}
        </Text>
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

function Working({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => n + 1), 140);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return (
    <Text color={BRAND}>
      {SPINNER[frame % SPINNER.length]} <Text color="gray">working… ({seconds}s)</Text>
    </Text>
  );
}

function Ask({ ask }: { ask: PendingAsk }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        <Text color="yellow" bold>
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
