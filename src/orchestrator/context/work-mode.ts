import fs from 'node:fs';
import path from 'node:path';
import type { Transcript } from '../../workspace/transcript.js';

/** User-selected work state, independent of ask/bypass permissions. */
export class WorkMode {
  readonly file: string;
  constructor(private readonly transcript: Transcript, runDir: string) {
    this.file = path.join(runDir, 'plan.md');
  }

  state(): { mode: 'plan' | 'execute'; plan: string } {
    let mode: 'plan' | 'execute' = 'execute';
    let plan = '';
    const turns = new Set<number>();
    for (const record of this.transcript.all()) {
      if (record.type === 'clear') { mode = 'execute'; plan = ''; turns.clear(); }
      if (record.type !== 'context') continue;
      if (record.entry.event === 'start') turns.add(record.seq);
      if (record.entry.event === 'mode') mode = record.entry.mode;
      if (record.entry.event === 'plan' && turns.has(record.entry.turn)) plan = record.entry.text;
    }
    return { mode, plan };
  }

  select(mode: 'plan' | 'execute'): void {
    this.transcript.append({ type: 'context', entry: { event: 'mode', mode } });
  }

  save(turn: number, text: string): void {
    const records = this.transcript.all();
    const floor = records.findLast((record) => record.type === 'clear')?.seq ?? 0;
    if (turn <= floor || !records.some((record) => record.seq === turn && record.type === 'context' && record.entry.event === 'start')) {
      throw new Error('This conversation was cleared; its plan cannot be updated.');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.transcript.append({ type: 'context', entry: { event: 'plan', turn, text } });
  }

  prompt(): string {
    const { mode, plan } = this.state();
    return `WORK MODE: ${mode}\n${mode === 'plan'
      ? 'Explore, reason and prepare a concrete plan. Delegate answer or inspect tasks only; do not implement changes or run commands. Save the plan with the plan tool before reporting. The user selects execution with /execute. This is task guidance, not a sandbox for adapter-native tools.'
      : 'Carry out the user request using the available tools. A saved plan supplies context; current user instructions take precedence.'}${plan ? `\nSAVED PLAN (${this.file}):\n${plan}` : ''}`;
  }
}
