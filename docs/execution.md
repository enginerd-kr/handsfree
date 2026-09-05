# Execution contracts and token efficiency

The execution core is `src/orchestrator/executor.ts`. It owns deterministic request validation, candidate selection, scheduling, result persistence, and idempotency. `Delegator` owns the ACP worker lifecycle. `Conversation` supplies the dialogue interface, and MCP and the `task` command supply structured interfaces.

## Interfaces

Start MCP in the project directory:

```sh
handsfree serve --mcp --permission-mode bypass
```

Use `ask` to send permission questions to an MCP client that supports form elicitation. Every permission request is forwarded, including requests that legacy policy settings would allow or deny. Without that support the request cannot be approved. `bypass` approves every permission request, including pending requests when the mode changes. Task kinds describe the requested scope in the worker brief; they do not override the user’s permission decision. General questions still require user input in either mode.

These permission modes govern operations routed through the host. The bundled Codex profile and example configuration set `nativeTools: "allow"`: Codex runs using adapter-native permissions and sandboxing, and its tasks always run exclusively. Host approval prompts do not govern its native tools. Setting `agents.<id>.nativeTools: "deny"` blocks known Codex ACP adapters before prompting; detection checks both launch profiles and handshake identity. Custom profiles that omit this setting still default to `"deny"`. Unknown adapters are not automatically certified safe. See the [live adapter findings](live-use-cases.md) and [follow-up controls](execution-controls.md).

The structured CLI returns one JSON result and a nonzero exit code for unsuccessful tasks:

```sh
handsfree task --permission-mode bypass '{"task":"Inspect src/parser.ts","kind":"inspect","agent":"claude"}'
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
| `requestId` | At-most-once retry key within a run. Different content under the same key fails. |
| `resolves` | Earlier task IDs whose recorded blockers/decisions this successful task supersedes. |

The result includes `taskId`, `runId`, `agent`, `status`, `summary`, `artifacts`, `blockers`, `verification`, `usage`, and `resultRef`. Full output is persisted separately under the run's `results` directory. Artifact and blocker lists in the compact result are bounded; full lists remain in the detailed result.

`end_turn` is a protocol termination signal, not proof of task completion. A report saying `blocked` or `partial` produces `blocked` or `incomplete`; cancellation and failure remain distinct. For backwards compatibility, a clean turn without a report is accepted as done, with verification marked `unreported`. `verification.source: agent_report` identifies the worker's claim, not an independent test performed by handsfree. Callers can add a verification task and inspect its evidence.

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

## Token efficiency and small models

```json
{
  "orchestration": {
    "provider": "api",
    "local": {"baseURL":"https://your-compatible-endpoint/v1","model":"your-small-model","apiKey":"your-key"},
    "contextBudgetTokens": 8000,
    "maxOutputTokens": 768,
    "maxRepairAttempts": 2
  },
  "execution": {"estimatedTaskTokens":4096,"routing":"auto","routingContextTokens":2048,"maxParallel":2,"maxBatchTasks":16,"maxCandidates":3,"rotateContextRatio":0.85},
  "prices": {}
}
```

Handsfree focuses on efficient token use. Account and spending limits belong to the provider; handsfree records usage without refusing or cancelling work based on token counts or USD cost. The former configuration `budget` block is ignored, and structured requests no longer accept `budget`. The cold-start estimate now lives at `execution.estimatedTaskTokens` and only informs ranking.

Both conversational planning and structured routing record usage. `provider: local` records selector tokens as local; `provider: api` and `provider: acp` record them as frontier usage. The legacy `local` configuration block holds the compatible endpoint for local and API providers. ACP opens a fresh planning session per call and releases its bookkeeping afterwards; workers keep their sessions. See [the conversation loop](agent-loop.md).

Candidate ranking considers recent usage and failure history, relevant unchanged files, and session occupancy. In `execution.routing: auto`, local/API selectors may be consulted, while ACP uses deterministic ranking without a selection call. `deterministic` always skips the selector; `model` explicitly permits it, including ACP. The selector sees neutral IDs and configured roles in a 2,048-token window. If the complete task cannot fit that small window, it is passed intact to the deterministically selected worker. The bounded selector chooses an ID from the shortlist in at most one model call; invalid replies fall back to the ranked candidate without repair calls. A single candidate, an explicit agent, or a strong context-affinity advantage skips selection. The dialogue planner retains its configurable bounded repair loop for conversational compatibility.

Worker estimates use the 90th percentile of the last eight positive usage records and the current reported context size; cold starts use `execution.estimatedTaskTokens`. These estimates rank candidates. Actual response usage replaces estimates in accounting, and failed calls are recorded too. Context occupancy is only a lower-bound signal, not cumulative billing usage. Token estimates use a character heuristic and do not guarantee a model's tokenizer count.

Cache reads and writes are counted in total tokens and priced separately. USD rates, when needed, are configured per model ID or agent ID as `input`, `output`, `cachedRead`, and `cachedWrite`, in USD per million tokens. There are no built-in model prices. Reported USD task cost is used when an adapter supplies it; missing prices leave cost unknown and do not block execution. Local inference has zero provider-billed cost in this accounting; hardware and electricity are not measured.

Planner context fitting reserves output and schema space. Compatible HTTP providers receive `maxOutputTokens` as a generation parameter; ACP replies are not cancelled based on their estimated token length. Required current-task context survives history eviction. If the mandatory content cannot fit, handsfree reports an error before calling the model. Status and blockers precede file lists in compact results, and omitted details are explicitly marked.

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

The benchmark uses fresh isolated workspaces and identical artifact checks for direct, conversational, and structured execution. It exercises a first task and a follow-up after the input file changes. The simulated worker reports deliberately modeled token counts, and the output is labeled `simulation`; these figures are not real model efficiency measurements. Live mode uses the same configured worker/model in all modes, records token usage and retains failed samples. Its small data-transformation fixture is a smoke benchmark, not evidence of broad coding quality.

Coverage includes goal retention under pressure, schema/output reserves, blocked reports, result paging, ACP embedded context and full answers, MCP cancellation, concurrent isolation, read-only enforcement, dependency failures, idempotency, session freshness, and usage reconciliation.

See [recorded simulation and live results](benchmark-results.md) for historical measured overhead and limitations.

See [three-agent live use cases](live-use-cases.md) for actual Claude/Gemini/Codex coordination, independent artifact checks, and adapter compatibility limits.
