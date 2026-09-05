# Execution contracts and token control

The execution core is `src/orchestrator/executor.ts`. It owns deterministic request validation, candidate selection, scheduling, result persistence, and idempotency. `Delegator` owns the ACP worker lifecycle. `Conversation` supplies the dialogue interface, and MCP and the `task` command supply structured interfaces.

## Interfaces

Start MCP in the project directory:

```sh
handsfree serve --mcp --permission-mode acceptEdits
```

Use `ask` to send permission questions to an MCP client that supports form elicitation. Without that support an unresolved permission request is denied. `acceptEdits` and `bypass` retain the existing policy-mode semantics. An `answer` or `inspect` task further restricts its session even in bypass mode.

The structured CLI returns one JSON result and a nonzero exit code for unsuccessful tasks:

```sh
handsfree task --permission-mode acceptEdits '{"task":"Inspect src/parser.ts","kind":"inspect","agent":"claude"}'
```

`--run <id>` reopens a run's sessions, usage, results, and request-ID journal. Use one persistent host for a run; this is not a distributed scheduler across multiple handsfree processes.

### `delegate`

| Input | Meaning |
| --- | --- |
| `task` | Required original task. The selector never rewrites it. |
| `kind` | `change` (default), `inspect` (file reads, no commands/edits), or `answer` (reply only). |
| `constraints` | Exact requirements preserved in the worker brief. |
| `acceptanceCriteria` | Conditions the worker is asked to satisfy and report. |
| `files` | Relevant paths used for context affinity and the brief. |
| `agent`, `model` | Optional explicit routing. Specifying `agent` skips the selector. |
| `sessionId` | Optional exact active session; requires `agent`. A stale ID fails instead of silently changing sessions. |
| `budget` | Optional `maxTokens`, `maxFrontierTokens`, and `maxCostUsd` for this request, including routing. |
| `requestId` | At-most-once retry key within a run. Different content under the same key fails. |
| `resolves` | Earlier task IDs whose recorded blockers/decisions this successful task supersedes. |

The result includes `taskId`, `runId`, `agent`, `status`, `summary`, `artifacts`, `blockers`, `verification`, `usage`, and `resultRef`. Full output is persisted separately under the run's `results` directory. Artifact and blocker lists in the compact result are bounded; full lists remain in the detailed result.

`end_turn` is a protocol termination signal, not proof of task completion. A report saying `blocked` or `partial` produces `blocked` or `incomplete`; cancellation, failure and budget exhaustion remain distinct. For backwards compatibility, a clean turn without a report is accepted as done, with verification marked `unreported`. `verification.source: agent_report` identifies the worker's claim, not an independent test performed by handsfree. Callers can add a verification task and inspect its evidence.

Before executing a keyed request, handsfree writes a journal entry. A completed request is returned from disk after restart. A request interrupted between execution and recording the result is left indeterminate and cannot be silently replayed; inspect the run and use a new key if a retry is appropriate. The journal does not claim transactionality for arbitrary filesystem or network effects.

### `batch`

```json
{
  "tasks": [
    {"id":"parser-review","request":{"task":"Inspect parser","kind":"inspect","agent":"claude"}},
    {"id":"test-review","request":{"task":"Inspect tests","kind":"inspect","agent":"gemini"}},
    {"id":"fix","dependsOn":["parser-review","test-review"],"request":{"task":"Apply the findings","agent":"codex"}}
  ]
}
```

Unknown dependencies, cycles, duplicate IDs and oversized batches are rejected before work starts. Failed prerequisites block dependent work. Prerequisite summaries, artifacts, and references accompany the dependent task's original requirements. Identical requests with identical dependencies in one batch share one execution. A worker session never receives overlapping prompts. A workspace lock allows concurrent inspections but serializes changes against all work, including other ACP runtimes in the same host process. Independent handsfree processes require separate writable checkouts or external coordination.

### `read_result`, resources, and `usage`

`read_result({taskId, offset:0, maxChars:8000})` returns a text page and an optional `nextOffset`. Its maximum page is 32,000 characters. The `handsfree://runs/{runId}/tasks/{taskId}` resource returns the first page. Resources are restricted to the current run; arbitrary paths cannot be supplied.

`usage` returns total tokens, frontier tokens, known USD cost, estimated-call count, and calls without known prices. `/cost` also shows this accounting in the conversation. Full reports are not inserted into the planner's context unless its `task_result` tool explicitly retrieves a page.

## Budgets and small models

```json
{
  "orchestration": {
    "provider": "api",
    "local": {"baseURL":"https://your-compatible-endpoint/v1","model":"your-small-model","apiKey":"your-key"},
    "contextBudgetTokens": 8000,
    "maxOutputTokens": 768,
    "maxRepairAttempts": 2
  },
  "budget": {
    "maxTokens": 200000,
    "maxFrontierTokens": 150000,
    "maxTaskTokens": 32000,
    "estimatedTaskTokens": 4096
  },
  "execution": {"maxParallel":2,"maxBatchTasks":16,"maxCandidates":3,"rotateContextRatio":0.85},
  "prices": {}
}
```

`provider: local` uses the same API client and treats planning tokens as local. `provider: api` counts them toward the frontier budget. The legacy `local` configuration block holds the compatible endpoint in both cases. `provider: acp` remains supported but incurs a fresh planning session per call. Ephemeral sessions are released from host bookkeeping; workers keep their sessions.

Run-wide token and USD limits are opt-in. The default per-call/task token limit is 32,000. Candidate ranking considers recent usage and failure history, relevant unchanged files, and session occupancy. The bounded selector chooses an ID from the shortlist in at most one model call; invalid replies fall back to the ranked candidate without repair calls. A single candidate, an explicit agent, or a strong context-affinity advantage skips selection. The dialogue planner retains its configurable bounded repair loop for conversational compatibility.

Reservations are made synchronously before calls so parallel workers cannot all claim the same remaining budget. Streaming output and ACP context updates can trigger cooperative cancellation. Actual response usage replaces estimates; failed calls are charged too. Context occupancy is only a lower-bound signal, not cumulative billing usage. Token estimates use a character heuristic and do not guarantee a model's tokenizer count. ACP adapters may omit live usage, report hidden context only at completion, or take time to cancel, so limits can be exceeded before the host learns the actual charge. These are admission and cooperative-stop controls, not a provider-enforced spending cap.

Cache reads and writes are counted in total tokens and priced separately. USD rates, when needed, are configured per model ID or agent ID as `input`, `output`, `cachedRead`, and `cachedWrite`, in USD per million tokens. There are no built-in model prices. A USD admission limit requires known rates; reported USD task cost is used when an adapter supplies it. Local inference has zero provider-billed cost in this accounting; hardware and electricity are not measured.

All planner calls reserve output and schema space. Required current-task context survives history eviction. If the mandatory content cannot fit, handsfree reports an error before calling the model. Status and blockers precede file lists in compact results, and omitted details are explicitly marked.

## Session memory

The host records file metadata versions, topics, task reports, and session IDs. Changed versions lose context-affinity credit and generate a re-read reminder. A large reported context drop invalidates older memory hints; an almost-full session is rotated before another task unless the request pins an exact session. Metadata versions are inexpensive freshness hints, not proof that a compacted model still remembers file contents.

Relevant decisions and open items are retrieved independently of the recent-task window. `resolves` explicitly supersedes older facts after successful work. Raw history remains available for audit. Task transcript extraction filters by task/agent/session so overlapping workers do not borrow one another's output or permission records.

## Validation and benchmarking

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark
pnpm benchmark --live
```

The benchmark uses fresh isolated workspaces and identical artifact checks for direct, conversational, and structured execution. It exercises a first task and a follow-up after the input file changes. The simulated worker reports deliberately modeled token counts, and the output is labeled `simulation`; these figures are not real model efficiency measurements. Live mode uses the same configured worker/model in all modes, enforces finite budgets, and records failed samples rather than excluding them. Its small data-transformation fixture is a smoke benchmark, not evidence of broad coding quality.

Coverage includes goal retention under pressure, schema/output reserves, blocked reports, result paging, ACP embedded context and full answers, MCP cancellation, concurrent isolation, read-only enforcement, dependency failures, idempotency, session freshness, and usage reconciliation.

See [recorded simulation and live results](benchmark-results.md) for the measured overhead and the live run's budget-exhaustion limits.
