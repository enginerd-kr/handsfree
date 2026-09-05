import type { Transcript, TranscriptRecord } from '../../workspace/transcript.js';
import { reference, referenceId } from '../../contracts/reference.js';
import type { SharedContextSelection, SharedContextSnapshot, SharedMessage } from '../../contracts/shared-context.js';

interface Collaboration {
  id: number;
  title: string;
  entries: Extract<TranscriptRecord, { type: 'shared_context' }>[];
  sources: Set<number>;
  tasks: Set<number>;
  turns: Set<number>;
}

/** Indexes explicit membership and source links; never infers a workflow. */
export class SharedConversations {
  private cursor = 0;
  private readonly records = new Map<number, TranscriptRecord>();
  private readonly conversations = new Map<number, Collaboration>();
  private readonly results = new Map<number, number>();
  constructor(private readonly transcript: Transcript) {}

  private sync(): void {
    const records = this.transcript.all();
    for (; this.cursor < records.length; this.cursor++) {
      const record = records[this.cursor]!;
      if (record.type === 'clear') {
        this.records.clear();
        this.conversations.clear();
        this.results.clear();
        continue;
      }
      this.records.set(record.seq, record);
      if (record.type === 'task_result') this.results.set(record.taskId, record.seq);
      if (record.type !== 'shared_context') continue;
      const entry = record.entry;
      if (entry.event === 'open') this.conversations.set(record.seq, {
        id: record.seq, title: entry.title, entries: [], sources: new Set(), tasks: new Set(), turns: new Set(),
      });
      const conversation = this.conversations.get(entry.event === 'open' ? record.seq : entry.conversation);
      if (!conversation) continue; // Late results cannot recreate a cleared scope.
      conversation.entries.push(record);
      if ('source' in entry) {
        conversation.sources.add(entry.source);
        const source = this.records.get(entry.source);
        if (source?.type === 'context' && source.entry.event === 'start') conversation.turns.add(source.seq);
        if (source?.type === 'task_result') conversation.tasks.add(source.taskId);
      }
    }
  }

  private get(ref: string): Collaboration {
    this.sync();
    const conversation = this.conversations.get(referenceId('conversation', ref));
    if (!conversation) throw new Error(`No shared conversation ${ref} in this conversation boundary. Call shared_context with operation:list to find an existing scope, or operation:open and a title to create one. Copy its returned conversation and through references; do not guess them.`);
    return conversation;
  }

  private userSources(turn: number): number[] {
    this.sync();
    const root = this.records.get(turn);
    if (root?.type !== 'context' || root.entry.event !== 'start') throw new Error('An active user request is required. The previous conversation may have been cleared.');
    return [turn, ...[...this.records.values()].filter((record) => record.type === 'context'
      && record.entry.event === 'update' && record.entry.turn === turn).map((record) => record.seq)];
  }

  open(turn: number, title: string): SharedContextSelection {
    const sources = this.userSources(turn);
    const id = this.transcript.append({ type: 'shared_context', entry: { event: 'open', title, source: turn } }).seq;
    const ref = reference('conversation', id);
    this.includeSources(ref, sources.slice(1));
    return this.head(ref);
  }

  /** Explicitly add another user turn when the model continues this collaboration. */
  include(ref: string, turn: number): SharedContextSelection {
    this.includeSources(ref, this.userSources(turn));
    return this.head(ref);
  }

  /** New user instructions enter only collaborations already attached to that turn. */
  update(turn: number): void {
    this.sync();
    for (const conversation of [...this.conversations.values()]) {
      if (conversation.turns.has(turn)) this.include(reference('conversation', conversation.id), turn);
    }
  }

  private includeSources(ref: string, sources: number[]): void {
    for (const source of sources) {
      const conversation = this.get(ref);
      if (!conversation.sources.has(source)) this.transcript.append({ type: 'shared_context',
        entry: { event: 'include', conversation: conversation.id, source } });
    }
  }

  note(ref: string, text: string): SharedContextSelection {
    const conversation = this.get(ref);
    this.transcript.append({ type: 'shared_context', entry: { event: 'note', conversation: conversation.id, text } });
    return this.head(ref);
  }

  /** Publish each saved result once, including its actual failure/partial status. */
  publish(ref: string, taskId: number): void {
    this.sync();
    const conversation = this.conversations.get(referenceId('conversation', ref));
    if (!conversation) return; // A task settling after /clear stays outside the new context.
    this.attach(ref, [reference('task', taskId)]);
  }

  /** Explicitly connect saved replies without rerunning workers or rewriting older snapshots. */
  attach(ref: string, tasks: string[]): SharedContextSelection {
    this.get(ref);
    // Validate the whole selection before publishing any source.
    const selected = [...new Set(tasks)].map((task) => {
      const taskId = referenceId('task', task);
      const source = this.results.get(taskId);
      if (source === undefined) throw new Error(`Cannot attach ${task}: no saved task result in this conversation boundary. Use task_result to find valid task references.`);
      return { taskId, source };
    }).sort((a, b) => a.source - b.source);
    for (const { taskId, source } of selected) {
      const conversation = this.get(ref);
      if (!conversation.tasks.has(taskId)) this.transcript.append({ type: 'shared_context',
        entry: { event: 'reply', conversation: conversation.id, source } });
    }
    return this.head(ref);
  }

  head(ref: string): SharedContextSelection {
    const conversation = this.get(ref);
    return { conversation: ref, through: reference('record', conversation.entries.at(-1)!.seq) };
  }

  list(turn?: number): (SharedContextSelection & { title: string; messages: number })[] {
    this.sync();
    return [...this.conversations.values()].filter((conversation) => turn === undefined || conversation.turns.has(turn)).map((conversation) => ({
      ...this.head(reference('conversation', conversation.id)), title: conversation.title, messages: conversation.entries.length,
    }));
  }

  resolve(selection: SharedContextSelection): SharedContextSnapshot {
    const conversation = this.get(selection.conversation);
    const through = referenceId('record', selection.through);
    const index = conversation.entries.findIndex((record) => record.seq === through);
    if (index === -1) throw new Error(`${selection.through} is not a message in ${selection.conversation}. Use shared_context.read to get its head or select one of its message records.`);
    // Each read creates a separate immutable-in-time value; later publications
    // cannot alter the selected prefix, even during grouped/background calls.
    const messages = conversation.entries.slice(0, index + 1).map((record): SharedMessage => {
      const entry = record.entry;
      const ref = reference('record', record.seq);
      if (entry.event === 'note') return { record: ref, source: ref, role: 'orchestrator', author: 'orchestrator', content: entry.text };
      const source = this.records.get(entry.source);
      const origin = reference('record', entry.source);
      if (source?.type === 'context' && (source.entry.event === 'start' || source.entry.event === 'update')) {
        return { record: ref, source: origin, role: 'user', author: 'user', content: source.entry.request };
      }
      if (source?.type === 'task_result') return { record: ref, source: origin, role: 'agent', author: source.result.agent,
        task: reference('task', source.taskId), status: source.result.status, content: source.result.message };
      throw new Error(`Shared source ${origin} is missing or invalid. No partial conversation can be delivered.`);
    });
    return { ...selection, title: conversation.title, messages };
  }
}
