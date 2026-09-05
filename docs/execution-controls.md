# Execution controls and lightweight routing — 2026-09-05

This follow-up addresses the three issues found in the [three-agent live run](live-use-cases.md): unmediated Codex tools, ACP input overhead exceeding the old task limit, and expensive ACP selection calls.

## Native execution

Known Codex ACP launches and handshake identities now fail before session prompting unless their agent profile explicitly sets `nativeTools: "allow"`. Automatic routing excludes known blocked profiles. `doctor` distinguishes a successful handshake from permission to execute. This is a fail-closed compatibility guard for known adapters, not a replacement implementation of Codex's native tools or a certification of unknown adapters.

Native opt-in tasks take the exclusive workspace lock even for inspections, because host read-only restrictions cannot reliably govern their native operations. Use the opt-in only when accepting adapter permissions or supplying external isolation. Default Codex execution remains disabled; it has not become universally host-mediated.

The installed `codex-acp 1.10.0` applies its mode's approval and sandbox policy to each turn. Its `read-only` mode ID actually selects workspace-write behavior in that version. Simply changing a launch environment variable would not restore host command-by-command enforcement. Official Codex configuration also distinguishes the approval reviewer from sandbox permissions: changing the reviewer does not affect actions already allowed inside the sandbox. [Official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

The real control check attempted an explicit Codex task and confirmed rejection with no launched Codex connection and zero charged tokens.

## Budgets

- Default task total: **128,000 tokens**, including cache reads/writes and reported thought tokens.
- Default generated output: **4,096 tokens**, monitored while streaming and reconciled at completion.
- Explicit smaller request/run limits still win; no limit is automatically increased during execution.
- Reservation estimates use the 90th percentile of the most recent eight positive worker charges, bounded below by current context occupancy and task size. Cold starts remain estimates.

The old 32,000-token task limit was below four of seven worker charges in the previous live suite. A larger total-input allowance avoids treating typical ACP setup as impossible work, while the separate output cap limits prolonged generation. This does not reduce the worker's billed input. Adapter-delayed usage and cooperative cancellation still allow overshoot; provider enforcement is not claimed.

The local project configuration now uses the 4B router, a 400,000-token run/frontier ceiling, and the task limits above. `handsfree.config.example.json` records the new router and task settings; the machine-specific project configuration remains git-ignored.

## Selector policy and transport

`execution.routing` accepts:

| Mode | Behavior |
| --- | --- |
| `auto` | Consult local/API selectors when ranking is ambiguous; skip ACP selection. |
| `deterministic` | Never call a selector. |
| `model` | Explicitly allow selection calls for any configured provider, including ACP. |

Explicit agents, one remaining candidate, and strong context affinity continue to skip selection. The dialogue interface retains its planner for conversation. Structured routing uses a 2,048-token context limit and 64 output tokens, with neutral candidate IDs mapped back to real agent IDs in code. Large tasks bypass the selector without truncating requirements. Invalid replies fall back to ranking without repair calls.

The compatible HTTP client merges adjacent same-role messages for small-model chat templates, strips private goal-retention metadata from the wire, supplies an output limit, and records streamed/cache usage. An HTTP-contract regression test covers the paid-API accounting path with a mocked transport. No remote paid API account was used for this evaluation.

## Real local measurements

The configured local server at `localhost:1234` exposed `google/gemma-3-4b`. The initial six-case evaluation with real brand IDs scored 5/6. After switching to neutral IDs and role-based selection, the original six cases plus six additional English/Korean cases scored **12/12**.

| Measurement | Observed |
| --- | ---: |
| Total local tokens, 12 calls | 1,363 |
| Mean tokens/call | 113.6 |
| Range | 106–121 |
| Mean latency after first call | 154 ms |
| Initial cold call before tuning | 11.5 s |

The cases cover feature implementation, text/CSV transformation, and regression testing/refactoring. This small role-classification evaluation is not a general task-quality guarantee. The first six cases informed the prompt change; the additional six were evaluated afterward. Model loading latency remains relevant.

A separate real integration check used the production executor with the local selector and a real Gemini worker. It produced the exact expected CSV bytes, returned `done`, charged **155 local routing tokens** and **24,041 frontier worker tokens**, and stayed within default task limits. The earlier ACP router used 22,800 tokens in a different scenario; these figures expose wrapper overhead but are not a controlled savings ratio.

## Reproduce

```sh
node --import tsx bench/routing.ts
node --import tsx bench/controls.ts
pnpm typecheck
pnpm test
pnpm build
```

Evidence retained locally:

- Baseline: `$TMPDIR/handsfree-routing-1788576901598.json`
- Neutral-ID evaluation: `$TMPDIR/handsfree-routing-1788577025960.json`
- Actual guard + local-to-Gemini execution: `$TMPDIR/handsfree-controls-Rw4Rmf/report.json`
