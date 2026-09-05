# Execution benchmark — 2026-09-05

For current streaming CPU measurements, session preparation and transition timing fields, see [performance](performance.md).

These historical results predate removal of host token/spending limits. Current benchmarks record usage without budget-based admission or cancellation.

Both runs used `bench/run.ts`: two order-aggregation tasks, with the input changed before the second task, in separate workspaces per mode. The host checks exact JSON artifacts. These are smoke samples, not a general coding-quality evaluation.

## Deterministic simulation

Command: `pnpm benchmark`. Token counts are modeled by the scripted worker and planner, including planning schema overhead; they are not measurements of a real model.

| Path | Valid artifacts | Total tokens | Frontier tokens | Planning tokens | Planner calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct worker | 2/2 | 6,276 | 6,276 | 0 | 0 |
| Conversation | 2/2 | 11,283 | 6,695 | 4,588 | 4 |
| Structured executor | 2/2 | 6,583 | 6,583 | 0 | 0 |

The structured path uses about 42% fewer total tokens than the conversation path in this simulation, but about 5% more than direct execution. The modeled conversation planner is local, so most of the total-token reduction is local planning overhead, not frontier usage. Structured execution skips routing because only one candidate is enabled.

## Live ACP smoke run

Command: `pnpm benchmark --live`. The configured ACP worker was `claude`, model alias `haiku`, in all three modes. The conversation also used that ACP model for planning. Each mode had a 60,000-token run admission limit and a 24,000-token per-call limit. Cached tokens count toward total usage.

| Path | Valid artifacts | Reported total tokens | Planning tokens | Planner calls | Worker calls | Failed calls | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct worker | 1/2 | 66,955 | 0 | 0 | 1 | 1 | 10.8 s |
| Conversation | 1/2 | 114,167 | 23,074 | 1 | 1 | 1 | 20.9 s |
| Structured executor | 1/2 | 91,707 | 0 | 0 | 1 | 1 | 15.6 s |

All token counts in this live run came from adapter usage reports. All modes produced the first valid artifact but exceeded the budget; the second task did not complete. The direct path reported `Run token budget exhausted`; the structured path rejected the next task because no candidate fit the remaining budget. Conversation failures were recorded in its transcript rather than thrown to the benchmark. The command exited with code 1, preserving failed samples.

The worker reported much more usage at completion than the host could estimate before admission. Cooperative cancellation cannot retroactively prevent that spend. Zero selector calls are verified for the structured path; a reliable reduction in real total tokens or USD cost is **not established** by this run. Direct execution used fewer total tokens than either orchestrated path. Prices were incomplete for direct and conversational execution, so known USD subtotals are not comparable total costs.

Re-run both commands after changing the worker, planner, or routing configuration. A broader evaluation needs repeated tasks, independent quality checks, and a provider or adapter exposing accurate usage.
