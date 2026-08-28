import type { Config } from '../config/schema.js';
import type { ConfigLocation } from '../config/load.js';
import { createRuntime } from '../runtime.js';
import { describeRecord } from '../ui/view-model.js';
import type { TranscriptRecord } from '../workspace/transcript.js';

export interface RunOptions {
  /** Emit the transcript as NDJSON instead of prose. */
  json: boolean;
  runId?: string;
  /** The files the settings were read from, strongest first, for `/config` to name. */
  configSources?: readonly ConfigLocation[];
}

/**
 * One turn, no terminal UI. Nothing here can prompt a human, so every escalated
 * permission request is denied — the same rule a CI job gets.
 */
export async function run(
  config: Config,
  prompt: string,
  options: RunOptions,
  write: (line: string) => void,
): Promise<number> {
  const runtime = createRuntime({
    config,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.configSources === undefined ? {} : { configSources: options.configSources }),
  });

  const onRecord = (record: TranscriptRecord) => {
    if (options.json) {
      write(JSON.stringify(record));
      return;
    }
    const line = describeRecord(record, runtime.workspace.dir);
    if (line) write(line);
  };
  runtime.transcript.on('record', onRecord);

  const stop = () => runtime.conversation.cancel();
  process.on('SIGINT', stop);

  try {
    await runtime.conversation.send(prompt);
    const failed = runtime.transcript
      .all()
      .some((record) => record.type === 'note' && record.level === 'error');
    return failed ? 1 : 0;
  } finally {
    process.off('SIGINT', stop);
    runtime.transcript.off('record', onRecord);
    await runtime.close();
  }
}
