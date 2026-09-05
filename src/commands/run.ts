import type { Config } from '../config/schema.js';
import type { ConfigLocation } from '../config/load.js';
import type { PermissionMode } from '../policy/mode.js';
import { createRuntime } from '../runtime.js';
import { stdinSeat } from '../ui/stdin-seat.js';
import { describeRecord } from '../ui/view-model.js';
import type { TranscriptRecord } from '../workspace/transcript.js';

export interface RunOptions {
  /** Emit the transcript as NDJSON instead of prose. */
  json: boolean;
  runId?: string;
  /** Work in this existing directory instead of a fresh sandbox. */
  attachTo?: string;
  /** The files the settings were read from, strongest first, for `/config` to name. */
  configSources?: readonly ConfigLocation[];
  /**
   * The mode to start in; `ask` when unset. Piped or in CI there is no seat,
   * so `ask` cannot approve requests; `bypass` needs no seat at all.
   */
  permissionMode?: PermissionMode;
}

/**
 * One turn, no terminal UI. There is still a person here when the command was
 * typed at a terminal, and an agent that stops mid-turn asks them on stderr;
 * piped or in CI there is nobody to ask, and every escalation is denied — the
 * rule a CI job has always had.
 */
export async function run(
  config: Config,
  prompt: string,
  options: RunOptions,
  write: (line: string) => void,
): Promise<number> {
  const runtime = createRuntime({
    config,
    escalator: stdinSeat(),
    runId: options.runId,
    attachTo: options.attachTo,
    configSources: options.configSources,
    permissionMode: options.permissionMode,
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

  // A reused run comes back with its record read in, earlier errors and all;
  // the exit code answers for this turn, so only what this turn wrote counts.
  const before = runtime.transcript.all().at(-1)?.seq ?? 0;
  try {
    await runtime.conversation.send(prompt);
    const failed = runtime.transcript
      .since(before)
      .some((record) => record.type === 'note' && record.level === 'error'
        || record.type === 'task_result' && record.result.status !== 'done');
    return failed ? 1 : 0;
  } finally {
    process.off('SIGINT', stop);
    runtime.transcript.off('record', onRecord);
    await runtime.close();
  }
}
