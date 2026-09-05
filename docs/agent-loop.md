# Conversation loop and durable context

The orchestrator owns the user's request through its final report. It can do reasoning and conversational work itself, delegate a focused brief to a worker, retrieve evidence, or update its working memory. A worker finishing is an input to the next decision; it does not end the request automatically.

```mermaid
flowchart TD
  U[User request] --> C[Build working context]
  C --> P[Analyze request or review latest result]
  P --> S[Work directly and save conclusions]
  P --> A[Select worker and write brief]
  P --> R[Retrieve existing evidence]
  S --> C
  A --> O[Worker result, including failures]
  O --> C
  R --> C
  P --> F[Report result or explain blocker]
```

Every model-facing action schema requires a `review` containing the objective, constraints, completed items, remaining items, the selected `next` index and any blocker. Index 0 selects the first remaining item; -1 means no selected item. A worker call with -1 defaults to the first remaining item. The host checkpoints accepted reviews automatically, including their source addresses. Successful worker execution completes the selected item in the host's state; a stale model review cannot undo that execution or cause the same item to run again in that turn. Saving a finding can complete the orchestrator's own selected intermediate item. This records execution, not independent verification of a conclusion's correctness.

`answer` is the orchestrator's final response and may itself perform a selected synthesis or explanation. If its review still lists other work and no concrete blocker, the host rejects the premature ending and asks for a next action. The model still determines what the evidence establishes; a protocol `end_turn` is not proof of correctness. The parser also accepts legacy actions without a review for direct routing and older clients.

`agent` executes worker tasks. `context` supplies additional source-linked memory and lets the orchestrator record its own intermediate work. `task_result` reads saved worker output without rerunning a task. The orchestrator reviews evidence after each result and revises remaining work.

## Storage and retrieval

The existing run directory is the persistence boundary:

| Data | Storage | Purpose |
| --- | --- | --- |
| Exact user requests, reviews, planning actions, notes and turn endings | `transcript.jsonl`, `context` records | Durable source of truth, replay and audit |
| Full worker outcomes | `results/<taskId>.json` | Paginated evidence retrieval |
| Active notes and searchable source addresses | In-memory `RunContext` index | Rebuilt from the run file on restart |
| Worker session IDs and file freshness | Existing session and memory records | Reuse relevant worker context |

Notes have a stable key, kind, text, source record IDs and an active flag. The kinds are `objective`, `constraint`, `decision`, `finding` and `open`. Reusing a key revises the active note; saving it with `active:false` resolves it. Earlier versions remain readable by record ID. Sources must exist in the current conversation. A note is the orchestrator's interpretation of those sources, not independent verification or an authorization grant.

The index processes only newly appended records. Task-ledger reconstruction is cached until task completion, resolution or clearing changes it. Searches use lexical relevance and recency; no database service or embedding model is required. This is an addressable graph of notes and source records, with a simple local search index. A database can replace the index later without changing the persisted evidence contract.

## Working context

Every planning step receives:

1. Stable instructions and tool schemas.
2. A bounded view of previous user/assistant turns.
3. The exact current request, latest review, and active objectives, constraints, decisions and open items.
4. Current worker sessions, compact task state and result source addresses.
5. The latest tool call and result.

Earlier tool exchanges leave the chat window after the next result; their actions and evidence remain addressable in the run file. Retrieved pages have a separate bounded evidence cache, so reading a second result does not erase the first result needed for comparison. Repeated identical reads share a cache entry. A completed page read records execution of the selected read item; `nextOffset` still indicates further evidence to retrieve when needed. Worker prose and reports precede long briefs in result pages. Recent findings have a bounded preview and an address for their full text. Active commitments and the exact current request are mandatory input: if they cannot fit, planning fails visibly instead of silently dropping them. Mandatory notes and the latest review are also attached to worker briefs, so a shortened model-written prompt does not erase saved constraints.

Restarting the same run reconstructs recent conversation and active notes. An unfinished turn is represented as interrupted, and its actions/results are available for inspection; workers are not automatically rerun. `/clear` creates a new context boundary. Old source IDs and late turn checkpoints cannot repopulate that context.

## Execution limits

The conversation orchestrator's calls are usage-metered but excluded from the worker token/spend budget. Its context window, output limit, request timeout and configurable `maxPlanSteps` still apply. The default planning-step ceiling is 32; this bounds accidental loops rather than optimizing token cost. Worker calls remain subject to `maxDelegationsPerTurn` and worker token limits. A context lookup, saved conclusion or result read does not consume a worker slot.

Worker errors and budget exhaustion return to planning, allowing another worker, an evidence lookup or a blocker report. A worker limit refuses further delegations but permits analysis. User cancellation ends the loop immediately. A step limit triggers a report with a limit note; it is stored as `limited`, not task completion. Direct `@agent` requests retain their direct routing and agent-owned reply.

The structured MCP/CLI executor keeps its own existing routing and budgeting contract. This redesign concerns the conversational loop.

## Validation

Tests cover self-only answers, intermediate self work, failed-worker recovery, constraint propagation, reads after worker exhaustion, disk replay, source paging and revisions, interrupted turns, clear boundaries, required context under pressure and conversation-pair eviction. A fixed context-size scenario measures the dynamic packet separately from the stable instruction prefix. Scripted models test host guarantees; live local-model checks separately assess whether the model uses the loop well.

An explicit live planner smoke check uses deterministic worker replies and restarts the same run before asking about the original constraints:

```sh
pnpm exec tsx bench/agent-loop.ts --model=qwen3.5-9b-mlx
```

This does not contact real worker CLIs or change saved configuration. It writes a JSON evidence file with planner outputs, context records, prompt sizes and worker call counts. The checks cover execution count and constraint recall; the final prose still needs qualitative review.

In local checks on 2026-09-05, Qwen 3.5 9B completed the two-worker sequence, reported a synthesis and recalled Korean-response and `--legacy` constraints after restart without repeating worker calls. Gemma 3 4B remained unreliable on the multi-step scenario: it sometimes attempted renewed delegation during final synthesis or emitted invalid plans. The default configured model was not changed. These are smoke checks with fixture workers, not a broad model-quality evaluation or proof of real coding correctness.
