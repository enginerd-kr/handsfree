import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { Runtime } from '../../runtime.js';
import { buildView, type Tone, type ViewItem } from '../view-model.js';

const COLOUR: Record<Tone, string | undefined> = {
  normal: undefined,
  muted: 'gray',
  good: 'green',
  bad: 'red',
  warn: 'yellow',
  accent: 'cyan',
};

interface PendingAsk {
  summary: string;
  detail: string;
  rule: string;
  agentId: string;
  answer: (allowed: boolean) => void;
}

export function App({ runtime }: { runtime: Runtime }): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [items, setItems] = useState<ViewItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<PendingAsk | undefined>();
  const pending = useRef<PendingAsk[]>([]);

  // The transcript is the model; the view is a pure function of it.
  useEffect(() => {
    const render = () => setItems(buildView(runtime.transcript.all(), runtime.workspace.dir));
    render();
    runtime.transcript.on('record', render);
    return () => {
      runtime.transcript.off('record', render);
    };
  }, [runtime]);

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

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      runtime.conversation.cancel();
      exit();
      return;
    }
    if (ask) {
      if (char === 'y' || char === 'Y') ask.answer(true);
      if (char === 'n' || char === 'N' || key.escape) ask.answer(false);
      return;
    }
    if (key.escape && busy) runtime.conversation.cancel();
  });

  const submit = (text: string) => {
    const trimmed = text.trim();
    setInput('');
    if (trimmed === '' || busy) return;
    if (trimmed === '/quit' || trimmed === '/exit') {
      exit();
      return;
    }
    if (trimmed === '/reset') {
      runtime.conversation.reset();
      return;
    }
    setBusy(true);
    void runtime.conversation.send(trimmed).finally(() => setBusy(false));
  };

  const rows = stdout?.rows ?? 30;
  const visible = useMemo(() => items.slice(-Math.max(rows - 8, 10)), [items, rows]);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          handsfree
        </Text>
        <Text color="gray"> · {runtime.workspace.dir}</Text>
      </Box>

      <Box flexDirection="column">
        {visible.map((item) => (
          <Entry key={item.key} item={item} />
        ))}
      </Box>

      {ask ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>
            {ask.agentId} wants to {ask.summary}
          </Text>
          {ask.detail ? <Text color="gray">{ask.detail}</Text> : null}
          <Text color="gray">rule: {ask.rule}</Text>
          <Text>
            <Text color="green">y</Text> allow once · <Text color="red">n</Text> refuse
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={busy ? 'yellow' : 'cyan'}>{busy ? '· ' : '> '}</Text>
          {busy ? (
            <Text color="gray">working — esc to cancel</Text>
          ) : (
            <TextInput value={input} onChange={setInput} onSubmit={submit} />
          )}
        </Box>
      )}
    </Box>
  );
}

function Entry({ item }: { item: ViewItem }): React.JSX.Element {
  const colour = COLOUR[item.tone];
  const prefix =
    item.role === 'user' ? '>' : item.role === 'handsfree' ? '' : item.role === 'agent' ? '│' : '·';

  return (
    <Box>
      <Box width={12} flexShrink={0}>
        <Text color={item.role === 'user' ? 'cyan' : 'gray'}>
          {prefix} {item.role === 'handsfree' ? '' : item.label}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={colour} wrap="wrap">
          {item.text}
        </Text>
      </Box>
    </Box>
  );
}
