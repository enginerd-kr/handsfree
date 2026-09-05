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

Each response carries `message`, `calls` and `finish`. Commentary can accompany several independently validated calls, or continue without calling a worker. `finish:true` requires a nonempty final message and an empty call list. Legacy `action:call` and `action:answer` objects remain readable. The model may include a `review` containing the objective, constraints, completed items, remaining items, an item index and a blocker as a progress note. The host records it as written, including source addresses. A review is optional and does not schedule calls or decide their completion. Worker success records the outcome of that invocation. The orchestrator decides what that evidence means for the user's objective and may call the same worker or revisit the same topic as needed.

`finish:true` ends the loop once outstanding background jobs have settled and their results have been delivered. The orchestrator decides when it can provide the requested result or explain a concrete obstacle. The host validates the action and tool arguments; it does not infer completion from progress-note wording, rewrite those notes, or suppress a call because the topic appeared in an earlier successful invocation. A protocol `end_turn` reports execution termination, not verification of the user's objective.

`agent` executes worker tasks or starts them in the background. `agent_job` lists, polls, waits for, cancels and follows up on those jobs. `plan` reads or saves the implementation plan. `context` supplies additional source-linked memory and lets the orchestrator record its own intermediate work. `shared_context` supplies scoped public conversations and explicit snapshots for collaboration. `task_result` reads saved worker output without rerunning a task. The orchestrator reviews evidence after each result and revises remaining work.

## Steering and optional plan mode

Ordinary input sent during a turn is recorded immediately and delivered as a `USER UPDATE` at the next model/tool boundary. The current tool settles; calls that have not started receive an explicit skipped result. The model then decides what to do with the original request, the returned evidence and the update. A final answer generated before the update is reconsidered. Esc cancels the active turn; it is separate from steering. Prompt-file commands wait for their own turn, while local commands remain available immediately.

`/plan [task]` selects planning in the same loop. The orchestrator can reason, inspect files, retrieve evidence and save a concrete Markdown plan with the `plan` tool. Change delegations are rejected in this mode. `/execute [instruction]` switches to execution and continues the saved plan, with any new instruction. Plans are stored in `<runDir>/plan.md` and versioned in the transcript. Work mode and plan content survive reopening the run, and `/clear` creates a fresh boundary.

Work mode is separate from permission mode: choosing plan or execute does not change `ask` or `bypass`. Already running worker prompts are not rewritten by a mode change. Planning guidance and task-kind checks are not a sandbox for adapter-native tools.

## Background agents

`agent` with `background:true` returns a reference such as `job:1` immediately, with a pending receipt. The orchestrator can start other work, inspect existing sources or wait through `agent_job`. Independent workers can overlap; the existing scheduler still serializes shared workspace changes and prompts to the same session. Completion notifications return full replies and their actual task references. `agent_job.wait` wakes when new user input arrives without cancelling its workers.

A follow-up targets a settled job's recipients with a new prompt. A job using shared context requires the model to select an explicit snapshot for the follow-up, or explicitly leave the collaboration with `shared_context:null`; it does not inherit a stale snapshot or silently advance to the latest conversation. Ordinary follow-ups reuse available sessions. References to other workers remain explicit through `shared_context` or `context_from`. A running job can be cancelled before following up. If the planner stops with an error or the user cancels the turn, outstanding jobs are cancelled and settled. Restart restores terminal results and marks unfinished jobs interrupted; it does not rerun them. Jobs from before `/clear` cannot re-enter the new conversation.

## Passing results between workers

`agent.context_from` selects full replies by task ID from this run. The host resolves all references before calling a worker and attaches the original replies with source agent, task ID and execution status. It preserves the full text, including failed or blocked results when the orchestrator wants help assessing them. The immediate `agent` tool result also includes the complete reply, so the final synthesis can assess the actual arguments without another retrieval call. The former `orchestration.relayAnswers` switch has been removed. Source results are data under the new brief's instructions. Missing references return an error to the orchestrator without calling a worker. Saved results remain available after restarting the same run.

For example, the orchestrator can call Claude, then ask Codex to review its exact reply:

```json
{"action":"call","tool":"agent","input":{"agent":"claude","kind":"answer","prompt":"Explain the proposed design."}}
```

After receiving `task:1`:

```json
{"action":"call","tool":"agent","input":{"agent":"codex","kind":"answer","prompt":"Evaluate Claude's argument and identify disagreements.","context_from":["task:1"]}}
```

The next decision can forward Codex's result back to Claude, call another worker, or produce a synthesis. For an orchestrator-written summary instead, it reads `task_result`, writes its summary into the next `agent.prompt`, and can include source references as well. No discussion mode, fixed sequence, or round count is built into the host.

An agent array sends independent copies of a brief with the same selected source results; it does not pass newly produced replies or report summaries between recipients inside that call. Workers retain their own session history unless a shared snapshot is selected. The orchestrator chooses all additional evidence through its prompt, `context_from` or `shared_context`; file freshness notices remain host metadata. Multiple `@mentions` go to the orchestrator so it can decide the relationships between participants. A single leading `@agent` retains direct routing.

## Shared conversations and snapshot selection

The orchestrator can open a collaboration with `shared_context`:

```json
{"operation":"open","title":"Compare the proposed designs"}
```

The host links the actual current user request and its updates, without asking the model to rewrite them. It returns a selection such as `{"conversation":"conversation:12","through":"record:12"}`. A worker call selects that exact prefix:

```json
{"agent":["claude","codex"],"kind":"answer","prompt":"Give your initial position.","shared_context":{"conversation":"conversation:12","through":"record:12"}}
```

Opening a scope does not enroll calls automatically. Once a scope is opened or continued for the current user request, omitting `agent.shared_context` returns `shared_context_required` with the available heads before any worker call or background job. This also covers `open` followed by an unscoped agent call in the same model response. The orchestrator must choose a snapshot, including for initial independent contributions, or explicitly set `shared_context:null` for an ordinary call outside shared conversations. Scopes from unrelated user turns do not impose this requirement. An accepted ordinary background call preserves that choice if a scope opens before it executes.

The worker receives its participant identity, a separate current-task instruction and the complete selected conversation. Each message names its author, shared message record and original source record; worker messages include their task reference and execution status. A name written inside a reply cannot redefine its source author or the recipient's identity. Workers are instructed to identify missing required replies instead of inventing them. Source prose is preserved verbatim. Overlapping `context_from` replies are not attached twice. Task instructions and result files store the selection, not a copy of the attached conversation.

Each shared call starts a fresh session on the existing agent connection, retaining the selected model. Reusing a private session could introduce another collaboration or replies newer than the selected snapshot. Full prefix delivery makes the selection meaningful even after restart or compaction. This initially favors explicit context over incremental delivery; repeated prefixes increase prompt size. Ordinary calls keep their existing session behavior.

Completed task results are published to the selected conversation, including failed or partial outcomes with their actual statuses. A receipt's `shared_context` identifies what was delivered; `conversation_head` identifies the latest point now available. Publication does not change an earlier snapshot. Reads, repeated observations and `agent.context_from` attachments do not publish additional worker contributions.

Existing replies made outside the scope can be connected explicitly with `{"operation":"attach","conversation":"conversation:12","context_from":["task:1","task:2"]}`. It validates the entire selection before publishing source links, in source-record order, with the original authors, text and statuses. It returns observed task references and a new head without running workers. Reattaching a task never duplicates it, even if its result has been saved again. Already selected prefixes remain unchanged; subsequent calls must choose the returned head to include the added replies.

For example, two independent opening calls can select the same initial snapshot. The next pair can select the head containing both opening replies. A later pair can select the accumulated head containing all four earlier replies. If Codex should react to a newly produced Claude reply, the orchestrator first receives that result, then selects a head containing it. The host implements no round count or speaker sequence.

`{"operation":"read","conversation":"conversation:12"}` returns the full latest conversation and its head. Add `through` to inspect an older prefix. `list` exposes available scopes and heads, also shown in run context after restart. `{"operation":"continue","conversation":"conversation:12"}` includes the actual current user turn when returning to an existing collaboration; unrelated turns are not added automatically. Updates during an included turn are appended without modifying older snapshots. `note` explicitly publishes the orchestrator's analysis with an orchestrator label; ordinary commentary, private reasoning and tool chatter are not implicitly shared.

Shared entries link to original request/update and task-result records in the transcript. Replay preserves membership, order and snapshots. `/clear` invalidates scopes; late worker results cannot resurrect them. Missing sources, a cutoff from another collaboration or an invalid reference are rejected before contacting any recipient or queuing a background job. No partial or silently truncated shared conversation is delivered.

## References and execution receipts

Conversation tools use distinct reference types. Bare numbers and references of the wrong kind are rejected before any calls in that model response execute. Persisted records and the structured CLI/MCP executor retain their numeric IDs.

| Reference | Conversation tool arguments | Example |
| --- | --- | --- |
| `task:N` | `agent.context_from`, `task_result.taskId`, follow-up `context_from` | `{"taskId":"task:3"}` |
| `record:N` | `context.record`, `context.sources` | `{"operation":"read","record":"record:70"}` |
| `job:N` | `agent_job.jobId`, `agent_job.jobIds` | `{"operation":"wait","jobIds":["job:1"]}` |
| `conversation:N` | `shared_context.conversation`, conversation in `agent.shared_context` | `{"conversation":"conversation:12","through":"record:24"}` |

Every tool result starts with a JSON receipt followed by its full text. The receipt describes the invocation, not whether the user's objective is complete. `status` is `ok`, `error`, `pending` or `cancelled`; `executed` records execution (`null` when an exception leaves it uncertain). `created_tasks` lists newly produced task results, including failed outcomes whose status must still be inspected. Retrieval and job observation instead report `observed_tasks`, with no new tasks created by the read.

For a missing task reference, `agent` returns a receipt such as:

```json
{"status":"error","executed":false,"created_tasks":[],"error":{"code":"invalid_task_reference","message":"Cannot attach task context. No agent was called.","valid_refs":["task:1","task:2"]}}
```

All source references are resolved before a worker is contacted or a background job is queued. The model can correct the call from `valid_refs`. Reading `task:2` again returns `created_tasks:[]` and `observed_tasks:["task:2"]`; it does not constitute another worker contribution. Standing instructions ask the model to compare the user's requirements with these actual results before claiming completion. The host adds no topic-specific counters, required review stage or completion gate.

## Storage and retrieval

The task instruction is stored separately from its `contextFrom` source IDs. Referenced replies stay in their original result records and are assembled only when sending the worker prompt. Task listings and later result reads do not copy the attachments into the instruction.

The existing run directory is the persistence boundary:

| Data | Storage | Purpose |
| --- | --- | --- |
| Exact user requests, reviews, planning actions, notes and turn endings | `transcript.jsonl`, `context` records | Durable source of truth, replay and audit |
| Plans and work mode | `plan.md` and transcript `context` records | Resume planning or execution independently of permissions |
| Background job lifecycle and replies | Transcript `agent_job` records | Poll, follow up and recover interrupted jobs |
| Shared conversation membership, user inputs and reply links | Transcript `shared_context` records | Rebuild exact scoped snapshots and audit delivered selections |
| Exact model-window checkpoints | Transcript `context.checkpoint` records | Recover older exchanges after a context overflow |
| Full worker outcomes | `results/<taskId>.json` | Paginated evidence retrieval |
| Active notes and searchable source addresses | In-memory `RunContext` index | Rebuilt from the run file on restart |
| Worker session IDs and file freshness | Existing session and memory records | Reuse relevant worker context |

Notes have a stable key, kind, text, source record IDs and an active flag. The kinds are `objective`, `constraint`, `decision`, `finding` and `open`. Reusing a key revises the active note; saving it with `active:false` resolves it. Earlier versions remain readable by record ID. Sources must exist in the current conversation. A note is the orchestrator's interpretation of those sources, not independent verification or an authorization grant.

The index processes only newly appended records. Task-ledger reconstruction is cached until task completion, resolution or clearing changes it. Searches use lexical relevance and recency; no database service or embedding model is required. This is an addressable graph of notes and source records, with a simple local search index. A database can replace the index later without changing the persisted evidence contract.

## Working context

During normal execution, every planning step receives:

1. Stable instructions and tool schemas.
2. All previous user/assistant turns in the current conversation.
3. The exact current request, latest optional review, and active objectives, constraints, decisions and open items.
4. Current worker sessions, task metadata, summaries from previous turns and result source addresses.
5. All tool calls and results from the current turn, plus any user updates.

Tool exchanges, including full worker replies, remain in the active turn. The run-state index omits summaries of those same replies to avoid repeating them. Retrieved evidence and saved findings are retained in full, and repeated identical reads share an entry. Worker prose and reports precede briefs in result retrieval. Active notes and the latest review are provided to the orchestrator; it carries relevant constraints, requested length and format into each worker prompt. Planner notes are not injected into workers automatically.

Restarting the same run reconstructs recent conversation and active notes. An unfinished turn is represented as interrupted, and its actions/results are available for inspection; workers are not automatically rerun. `/clear` creates a new context boundary. Old source IDs and late turn checkpoints cannot repopulate that context.

Answer tasks ask for the requested prose or format without a `REPORT` block. Inspection and change tasks retain structured outcome and verification reports, specified for the current task even after an answer in the same session. All task kinds return the full reply to the orchestrator.

## Model recovery

API and ACP adapters report normalized completion metadata. A truncated response is never executed, even if it contains parseable JSON. The loop requests one shorter replacement; repeated truncation is reported as a failure. Invalid response shapes get up to two repair requests. Authentication and refusal errors stop immediately, without calling the failing model again to narrate the error. These recovery rules do not impose limits on valid planning steps, delegations, spending or task duration.

On a context overflow, handsfree persists the exact active messages in a checkpoint and retries once with a smaller view. It retains user requests and updates, required notes and the plan, the latest worker replies and their call/result groups. Older exchanges stay readable by checkpoint record ID; full outcomes stay in their result files. `context.read` and `task_result` accept optional `maxChars` and return `nextOffset` for selected pages. If the required evidence still cannot fit, the loop reports the context failure rather than repeatedly sending the same overflowing request.

## Execution and cancellation

Planner and worker calls are metered without token, spending, character, step or delegation limits. There are no automatic request deadlines. Worker errors return to planning for recovery, evidence lookup or a blocker report. User cancellation ends the loop and closes an active worker connection. Direct `@agent` requests retain their direct routing and agent-owned reply.

The structured MCP/CLI executor also runs without numerical limits; workspace exclusion and one prompt at a time per worker session preserve execution ordering.

## Validation

Tests cover commentary with multiple calls, atomic call validation, mid-turn steering, stale final answers, persistent plan/execute transitions, background concurrency and session reuse, cancellation, job replay, typed API/ACP termination and context recovery with exact checkpoints. They also cover self-only answers, intermediate self work, failed-worker recovery, constraint propagation, repeated delegation and result reads, disk replay, complete source retrieval and revisions, interrupted turns, clear boundaries, full context/history retention, large batches and explicit cancellation. Result-context tests verify exact worker-to-worker transfer, orchestrator-written summaries, rebuttals, missing references, failed-result forwarding, independent opening statements, final rebuttal delivery, absence of implicit summaries or planner notes, separate instruction/reference storage, and reuse after restart. Scripted models test host guarantees; live local-model checks separately assess whether the model uses the loop well.

An explicit live planner smoke check uses deterministic worker replies and restarts the same run before asking about the original constraints:

```sh
pnpm exec tsx bench/agent-loop.ts --model=qwen3.5-9b-mlx
```

This does not contact real worker CLIs or change saved configuration. It writes a JSON evidence file with planner outputs, context records, prompt sizes and worker call counts. The checks cover execution count and constraint recall; the final prose still needs qualitative review.

To exercise reference recovery with the currently configured planner (ACP or local):

```sh
node --import tsx bench/reference-recovery.ts
```

This check uses fixture Claude/Codex workers and asks for three contributions from each. It runs a baseline entirely with the live model. A separate recovery scenario replays two contributions from each worker and a third call with nonexistent references, then asks the live model what to do next. Only the benchmark replays calls and checks contribution counts; the model decides how to recover. A JSON evidence file distinguishes model replies from replayed calls and preserves receipts and worker prompts for review. Use `--recovery-only` to run just the replay scenario, or `--local --model=qwen3.5-9b-mlx` to select a local endpoint for this check. The benchmark has a watchdog; production execution limits are unchanged.

Add `--shared-context` to run the live planner with a request for independent openings followed by contributions based on the entire accumulated discussion. This mode also checks that the original user request and both sides' earlier replies appear in each selected worker context. Shared-context integration tests cover full long replies, identical group snapshots, fresh sessions, sequential selection, separate scope cutoffs, user updates, restart, cleared scopes, explicit orchestrator notes, background follow-ups and failed outcome publication.

The 2026-09-05 shared-context smoke check with Qwen 3.5 9B completed three contributions per fixture worker. Every call received the exact original user request; second contributions received both first replies, and third contributions received all four earlier replies. Each pair selected an identical snapshot and each call used a fresh session. The model initially guessed nonexistent scope references; those attempts contacted no workers, and it recovered by opening a scope and using returned selections. It also chose `change` for a discussion, so this smoke check demonstrates context delivery and recovery, not reliable task-kind judgment or real-worker reasoning quality.

The later real Gemini ACP run `2026-09-05T13-14-01-19416-3623450d` exposed a missing-selection path: it opened `conversation:17` and called both opening speakers without `agent.shared_context` in the same response. Tasks 1 and 2 were saved but never published to that scope. Round 2 selected `record:17`, which still contained only the user request; round 3 contained only the second replies. Both workers reported the missing first replies, and Claude later mislabeled itself as Codex. Regression tests replay that opening batch for synchronous and background calls, verify rejection before execution and recovery with both complete opening replies, and cover explicit attachment of existing replies without rerunning them. Recipient identity and missing-evidence instructions are now included in shared briefs. The host still leaves snapshot choice, participant order and completion to the orchestrator.

The subsequent Qwen 3.5 9B check (`node --import tsx bench/reference-recovery.ts --local --model=qwen3.5-9b-mlx --missing-shared-context`) replayed that same missing-selection batch. No worker ran on the invalid call. The real planner recovered with an explicit opening snapshot, and both second contributions received both original opening replies. The full scenario nevertheless failed: it added another Claude call with an older prefix containing only Claude's opening, stopped at 3/2 calls and claimed 3/3. Evidence is saved as `handsfree-reference-check-1788615094022.json` in the local temporary directory. This confirms missing-selection recovery and second-turn delivery, not reliable later snapshot selection or completion judgment. Unit/integration validation passed 791 tests, type checking and the build.

In local checks on 2026-09-05, Qwen 3.5 9B completed the two-worker sequence, reported a synthesis and recalled Korean-response and `--legacy` constraints after restart without repeating worker calls. Gemma 3 4B remained unreliable on the multi-step scenario: it sometimes attempted renewed delegation during final synthesis or emitted invalid plans. The default configured model was not changed. These are smoke checks with fixture workers, not a broad model-quality evaluation or proof of real coding correctness.

Reference checks on the same date with Qwen 3.5 9B completed an unrestricted three-contribution baseline. In the replay scenario, the model used the returned valid task references to recover from the failed third call, obtained the two remaining replies and synthesized all three contributions per worker. A separate unrestricted run stopped after three Claude replies and two Codex replies while claiming completion. Thus the interface supports recovery but does not guarantee the model's completion judgment. The configured Gemini ACP model could not be evaluated because its required `GEMINI_API_KEY` was absent from the benchmark environment.
