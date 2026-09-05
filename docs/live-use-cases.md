# Three-agent live integration check — 2026-09-05

The actual installed CLI adapters ran through the MCP tool server and shared executor. No worker or selector was mocked. MCP used an in-process transport; this run does not independently validate an external client's stdio configuration.

## Setup

| Component | Session-reported model | Adapter |
| --- | --- | --- |
| Router | configured `claude:haiku` | Claude ACP |
| Claude | `claude-fable-5-1[1m]` | `claude-agent-acp 0.74.0` |
| Gemini | `auto` | `gemini-cli 0.57.0` |
| Codex | `gpt-6-astra` | `codex-acp 1.10.0` |

`auto` is the Gemini session's reported selection, not proof of a specific underlying model. Each worker used its configured CLI default; the router used the separate small-model setting.

Fixtures lived in a fresh temporary workspace. The suite enabled the terminal capability with a restricted command allowlist and used `acceptEdits`. Functional-test budgets were 240,000 tokens per task and 1,200,000 per run; project defaults were preserved. The project configuration currently disables host terminal execution, and its default 32,000-token task limit is smaller than the reported usage of four worker calls in this run.

## Observed behavior

| Scenario | Result and independent evidence |
| --- | --- |
| Real sessions | All three CLI sessions opened. |
| Automatic routing | One small-selector call selected Claude; the full reply contained `ROUTING_OK`. |
| Parallel reviews | Claude reviewed the implementation while Gemini reviewed requirements/tests. Both delegations began before either stopped. |
| Dependent implementation | Codex started after both reviews finished and fixed the requested source file. Explicit routing made no planner calls. |
| Correctness and scope | Five host-owned tests passed: cancellation, first-seen order, negative/empty inputs, opaque keys, and immutable input. Protected requirements and test files were unchanged. |
| Duplicate requests | Concurrent identical Gemini requests produced one worker call and the same task ID. CSV bytes matched the expected output. |
| Changed input/session reuse | Gemini reused its session, the host marked `orders.json` stale, and regenerated exact CSV values including a negative total. |
| Missing prerequisite | Claude reported a missing schema as blocked. The Codex dependent task did not run or create its sentinel file. |
| Full result retrieval | Nine MCP pages reassembled the complete saved result. |
| Insufficient request budget | A one-token budget was rejected before any worker call. |

All 12 initial scenario checks passed, but manual inspection uncovered metadata and adapter-control issues that those checks did not cover. The suite now also checks Codex change/verification metadata explicitly.

## Defects found and limits

1. **Codex REPORT boundary loss — fixed.** The adapter emitted commentary, tool events, then a final REPORT without a leading newline. Joining all message chunks directly turned the heading into `...names.REPORT`, so the parser marked verification as unreported. Message assembly now preserves boundaries across tool exchanges while preserving individual streamed chunks.
2. **Codex changed-file loss — fixed.** The adapter put edited paths in `content: [{type: "diff", path: ...}]` without `locations`. File tracking now reads both representations. Replaying the captured real task recovers `src/summarize.js`, the structured summary, and `verify: node --test summary.test.js`. The original live result remains unchanged as evidence; the corrections were validated by replay and regression tests, without paying for a repeated model run.
3. **Native adapter operations are not universally mediated — unresolved compatibility limit.** Codex emitted three native execute calls and an edit notification, with zero host permission decisions. A compound command containing `git status --short` ran even though that command was absent from this suite's host allowlist. Declaring ACP terminal support did not make this adapter delegate all execution to the host. The run verifies functional behavior, not universal enforcement of the host's command or filesystem policy. Prompt compliance and adapter-native permissions must not be mistaken for host enforcement; strict isolation needs compatible adapters or an external sandbox.
4. **A review can contain an incorrect assumption.** Claude's review assumed a `status` cancellation field because it had not read the tests. Gemini's findings and Codex's direct test inspection resolved the actual `cancelled` field. Compact reports remain claims to verify, not authoritative specifications.

## Usage

| Source | Calls | Reported tokens |
| --- | ---: | ---: |
| Small router | 1 | 22,800 |
| Claude worker | 3 | 110,939 |
| Gemini worker | 3 | 129,011 |
| Codex worker | 1 | 20,042 |
| Total | 8 | 282,792 |

All token totals came from adapters; none were character estimates. The run took about 124 seconds. Known USD subtotals were incomplete for five calls, so this is not a complete cost measurement. The ACP small router itself consumed 22,800 tokens including its wrapper/cached context; this supports keeping explicit routing model-free and measuring local/API routing separately. This suite is a functional check, not a controlled token-savings comparison between models.

## Reproduce and inspect

```sh
node --import tsx bench/use-cases.ts
```

This command makes real model calls and prints its evidence directory. It retains fixtures, reports, JSONL transcript, full outcomes, and host-owned test output outside the repository. It exits nonzero when a scenario assertion fails.

Evidence from this run:

- Root: `/var/folders/86/4tbfn5t53vb2jjy293m0_qmh0000gn/T/handsfree-use-cases-KdDYgw`
- Run: `2026-09-05T02-40-12-88854-156d3993`
- `report.json`: original live checks, model selections, usage and results.
- `host-tests.txt`: independent artifact test output.
- `replay-check.json`: before/after metadata extraction from the same real Codex transcript.
