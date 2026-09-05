# Execution contracts and token efficiency

The execution core is [`src/orchestrator/execution/executor.ts`](../src/orchestrator/execution/executor.ts). It owns deterministic request validation, candidate selection, scheduling, result persistence, and idempotency. `Delegator` owns the ACP worker lifecycle. `Conversation` supplies the dialogue interface, and MCP and the `task` command supply structured interfaces. Shared request and result schemas live in `src/contracts/task.ts`; see [source architecture](architecture.md) for the full dependency structure.

## Interfaces

Start MCP in the project directory:

```sh
handsfree serve --mcp --permission-mode bypass
```

Use `ask` to send permission questions to an MCP client that supports form elicitation. Every permission request is forwarded. Permission rules are not configured in settings. Without that support the request cannot be approved. `bypass` approves every permission request, including pending requests when the mode changes. Task kinds describe the requested scope in the worker brief; they do not override the user’s permission decision. General questions still require user input in either mode.

The `policy` configuration block has been removed. Host command timeout, output size, and inherited environment names now live under `execution.terminal` as `timeoutMs`, `outputByteLimit`, and `env`. Approval and question deadlines use `limits.decisionTimeoutMs`. Older configuration files migrate these resource values at load time; file/command permission rules are discarded. Current field names win within the same file, and project settings still override user settings.

These permission modes govern operations routed through the host. All agent profiles default to `nativeTools: "allow"`: Codex runs using adapter-native permissions and sandboxing, and its tasks always run exclusively. Host approval prompts do not govern its native tools. Setting `agents.<id>.nativeTools: "deny"` blocks known Codex ACP adapters before prompting; detection checks both launch profiles and handshake identity. Existing and custom profiles that omit this setting also default to `"allow"`. Profiles allowing native tools always run tasks exclusively. Unknown adapters are not automatically certified safe. See the [live adapter findings](live-use-cases.md) and [follow-up controls](execution-controls.md).

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

The result includes `taskId`, `runId`, `agent`, `status`, `summary`, `artifacts`, `blockers`, `verification`, `usage`, and `resultRef`. Full output is persisted separately under the run's `results` directory. Artifact and blocker lists are returned in full.

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

Unknown dependencies, cycles and duplicate IDs are rejected before work starts. Failed prerequisites block dependent work. Prerequisite summaries, artifacts, and references accompany the dependent task's original requirements. Identical requests with identical dependencies in one batch share one execution. A worker session never receives overlapping prompts. A workspace lock allows concurrent inspections but serializes changes against all work, including other ACP runtimes in the same host process. Independent handsfree processes require separate writable checkouts or external coordination.

### `read_result`, resources, and `usage`

`read_result({taskId, offset:0, maxChars:8000})` returns a text page and an optional `nextOffset`. Omitting `maxChars` returns the complete result; explicit page sizes have no upper ceiling. The `handsfree://runs/{runId}/tasks/{taskId}` resource returns the complete result. Resources are restricted to the current run; arbitrary paths cannot be supplied.

`usage` returns total tokens, frontier tokens, known USD cost, estimated-call count, and calls without known prices. `/cost` also shows this accounting in the conversation. Full reports are not inserted into the planner's context unless its `task_result` tool explicitly retrieves a page.

## Models and usage

```json
{
  "orchestration": {
    "provider": "api",
    "local": {"baseURL":"https://your-compatible-endpoint/v1","model":"your-model","apiKey":"your-key"}
  },
  "execution": {"routing":"auto"},
  "prices": {}
}
```

Handsfree does not impose token or USD budgets, output or context ceilings, planning/delegation counts, batch/candidate/parallel counts, or handshake, turn, idle, command and approval deadlines. Previous `budget`, `limits`, and `policy` configuration blocks and their orchestration/execution limit fields are no longer read. Older configuration files may still load, but those fields are ignored. The structured task contract no longer accepts `budget`.

Conversation history, reports, handoffs and retrieved results are passed without automatic truncation. The planner can repair invalid replies and continue taking steps until it answers, an operation fails, or the user cancels. Model servers and adapters still have their own context and output capacities. Explicit user cancellation closes the affected connection immediately; a subsequent worker task opens a new connection. Approvals remain governed by the session's `ask`/`bypass` mode and can be withdrawn by cancellation. Command environments inherit the host environment and apply the caller's overrides.

In `execution.routing: auto`, local/API selectors may be consulted, while ACP uses deterministic ranking. `deterministic` always skips selection; `model` enables it for any provider. Selection considers all eligible agents and receives the complete task. Invalid selection replies fall back to ranking. An explicit agent, a single candidate, or strong context affinity skips selection. Worker sessions are serialized and workspace changes run exclusively to prevent conflicting work; independent inspections have no numerical parallel ceiling.

Usage accounting remains available for planners and workers, including failed calls. `provider: local` attributes selector usage to local inference; `api` and `acp` attribute it to frontier models. Provider counts replace character-based estimates when reported. Cache reads and writes are counted and priced separately. Rates are configured per model or agent as `input`, `output`, `cachedRead`, and `cachedWrite`, in USD per million tokens. Missing prices do not block execution. Reported USD cost is used when available; local inference records zero provider-billed cost.

## Session memory

The host records file metadata versions, topics, task reports, and session IDs. Changed versions lose context-affinity credit and generate a re-read reminder. A large reported context drop invalidates older memory hints; session rotation is explicit rather than triggered by a context ratio. Metadata versions are inexpensive freshness hints, not proof that a compacted model still remembers file contents.

Relevant decisions and open items are retrieved from the complete task record. `resolves` explicitly supersedes older facts after successful work. Raw history remains available for audit. Task transcript extraction filters by task/agent/session so overlapping workers do not borrow one another's output or permission records.

## Validation and benchmarking

Run shutdown closes worker and planner ACP transports, including pending handshakes, before ending the transcript. No new agent launches or fallback attempts are accepted once shutdown starts. The CLI also drains active runtimes on SIGINT, SIGTERM and SIGHUP, including TUI sessions. Adapters first receive stdin EOF; any remaining process group receives SIGTERM and a two-second grace before SIGKILL. A wrapper that exits early still has its descendants cleaned up. SIGKILL of the handsfree host itself cannot run this cleanup.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark
pnpm benchmark --live
```

The benchmark uses fresh isolated workspaces and identical artifact checks for direct, conversational, and structured execution. It exercises a first task and a follow-up after the input file changes. The simulated worker reports deliberately modeled token counts, and the output is labeled `simulation`; these figures are not real model efficiency measurements. Live mode uses the same configured worker/model in all modes, records usage and failed samples rather than excluding them. Its small data-transformation fixture is a smoke benchmark, not evidence of broad coding quality.

Coverage includes complete goal/history delivery, large outputs, blocked reports, result paging, ACP embedded context and full answers, MCP cancellation, concurrent isolation, read-only enforcement, dependency failures, idempotency, session freshness, and usage reconciliation.

See [recorded simulation and live results](benchmark-results.md) for the measured overhead and the historical live run's limitations.

See [three-agent live use cases](live-use-cases.md) for actual Claude/Gemini/Codex coordination, independent artifact checks, and adapter compatibility limits.
