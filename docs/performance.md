# Streaming and agent transition performance

The TUI consumes transcript records incrementally and retains unchanged row objects. Text chunks are coalesced into 24 ms frames. Completed replies, decisions, clear events and other control updates flush immediately; raw transcript records are preserved. Working state, phase, session and usage selectors run only when relevant events arrive.

Markdown rendering reuses unchanged rows, layout retains their measured heights, and scrollback keeps cumulative heights for its unchanged prefix. An unfinished code block defers syntax highlighting until it settles. Resizing, changing folds, clearing and replacing streamed text invalidate the affected presentation state. Interleaved worker updates retain their task and session ownership, including when one task finishes before another.

## Reproduce the CPU comparison

```sh
pnpm benchmark:performance
```

`bench/performance.ts` compares rebuilding the entire view and its status selectors on each frame with consuming new records and reusing unchanged rows. Both paths use the current markdown and layout implementations. The baseline recreates the earlier full-rebuild workflow; it is not a separate historical checkout.

Each completed task contains 100 text chunks, about 6,700 characters of mixed Korean/English markdown. Width is 100 columns and syntax highlighting is disabled. Each case warms up five times, then reports median and p95 across 20 samples. The incremental case appends one new text chunk per sample, including warmup. Initial transcript ingestion is outside the incremental frame measurement.

Sample on 2026-09-05, Node 22.14.0:

| Completed replies | History records | Full rebuild median | Incremental median | Incremental p95 |
| --- | ---: | ---: | ---: | ---: |
| 10 | 1,030 | 30.30 ms | 0.09 ms | 0.10 ms |
| 50 | 5,150 | 149.27 ms | 0.44 ms | 0.48 ms |
| 100 | 10,300 | 296.39 ms | 0.78 ms | 0.83 ms |

These are CPU measurements for synthetic history, excluding React/Ink rendering, terminal I/O, disk I/O and provider inference. They do not establish an equivalent improvement in total user-visible latency. Very long unfinished blocks still require parsing and wrapping their changing text; snapshots still visit the visible rows.

## Agent transitions

- The TUI prepares the ACP planner alongside the worker roster. Shared-context workers and ACP planners reserve at most one unused session per connection. Session creation and model setup can overlap current work; no speculative prompts are sent. Ordinary worker calls continue to reuse their active session.
- A reserved session does not replace the saved active session until adopted. Shared calls still receive a fresh session and the complete selected public conversation, preserving older snapshot boundaries and excluding private history. A setup failure can fall back to normal session creation.
- Shared prompts place unchanged source text before the advancing head and current assignment, preserving exact prefix text for providers that cache it. Evidence is not summarized or dropped; actual cache hits depend on the adapter and provider.
- An agent array submits independent requests together. Same-agent work, workspace changes and known native-tool adapters retain scheduler exclusion. Replies and shared publications are assembled in recipient order after the group settles. Dependent calls still wait for the evidence they require.
- Replacing the planner starts preparation of the new client while the old client shuts down. Runtime shutdown joins both active and retired clients. The planner is instructed to batch already-decided work; the host does not invent later steps or assume completion.
- Candidate ranking reuses the context usage it already calculated instead of rescanning session memory and restatting its files for the estimate.

## Locate remaining latency

The run's `transcript.jsonl` contains `timing` records for worker prompts and ACP planner prompts. The same measurements appear as `latency` entries with `--debug` enabled. Durations use a monotonic clock and are milliseconds:

| Field | Meaning |
| --- | --- |
| `queueMs` | Worker scheduler wait; zero for the ACP planner |
| `sessionMs` | Time obtaining the connection/session, including setup already awaited there |
| `prepareMs` | Remaining local/model preparation before prompt submission |
| `firstUpdateMs` | Prompt submission to the first session update |
| `firstOutputMs` | Prompt submission to the first nonempty agent message text, excluding thoughts |
| `promptMs` | Prompt submission through completion or failure/cancellation handling |
| `totalMs` | The measured path through prompt completion, including queue wait for workers |

First-update/output fields are absent when none arrives. Detailed timing requires reaching the prompt path; early setup failures retain their existing error records. Result summarization and persistence happen after the worker timing record. Every metered planner call, including local/API calls, also records `usage.durationMs` and, when streamed text arrives, `usage.firstDeltaMs`. That delta may be routing JSON rather than text displayed to the user.

A high `queueMs` points to workspace exclusion or another task on the agent. A high `sessionMs` points to startup, session loading/creation or model selection. A high `firstOutputMs` with low setup costs points toward the adapter/model or reasoning before its first message. Compare these with UI frame costs before changing model settings. Real provider transition times were not measured in this CPU benchmark.

Regression coverage includes stable frame snapshots, interleaved task attribution, completion/clear flushing, resizing/folding, session adoption and recovery, group concurrency and cancellation, planner replacement, and process cleanup.
