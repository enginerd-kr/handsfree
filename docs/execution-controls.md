# Execution controls and lightweight routing — 2026-09-05

This is a historical evaluation. Token, output, context and execution limits, including the native-tool execution switch, have since been removed; see [current execution behavior](execution.md).

This follow-up addresses the three issues found in the [three-agent live run](live-use-cases.md): unmediated Codex tools, ACP input overhead exceeding the old task limit, and expensive ACP selection calls.

## Native execution

At the time of this evaluation, known Codex ACP launches and handshake identities were blocked before prompting unless explicitly enabled. Automatic routing excluded blocked profiles, and `doctor` reported their execution status. That gate has been removed: enabled Codex profiles now run regardless of the former setting.

Known native execution tasks continue to take the exclusive workspace lock even for inspections. Codex uses its adapter's permissions and sandbox.

The installed `codex-acp 1.10.0` applies its mode's approval and sandbox policy to each turn. Its `read-only` mode ID actually selects workspace-write behavior in that version. Simply changing a launch environment variable would not restore host command-by-command enforcement. Official Codex configuration also distinguishes the approval reviewer from sandbox permissions: changing the reviewer does not affect actions already allowed inside the sandbox. [Official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

The original control check confirmed rejection with no launched Codex connection and zero charged tokens. The current control script checks successful Codex execution.

## Token efficiency and usage

Handsfree no longer enforces run, task, frontier-token or USD budgets. Token counts and estimated output length do not cancel workers or ACP planners, and large final usage reports do not turn completed work into failure. Provider accounts own spending limits.

Usage and cost reporting remain available. Candidate ranking uses the 90th percentile of the most recent eight positive worker usage records, bounded below by current context occupancy and task size. `execution.estimatedTaskTokens` supplies the cold-start estimate. Context reuse, concise handoffs and lightweight selection reduce orchestration overhead.

The configuration used for this evaluation selected the 4B router, a 400,000-token run/frontier ceiling, and the task limits above. Current settings live in `~/.handsfree/config.json`, and the former limits have been removed.

## Selector policy and transport

`execution.routing` accepts:

| Mode | Behavior |
| --- | --- |
| `auto` | Consult local/API selectors when ranking is ambiguous; skip ACP selection. |
| `deterministic` | Never call a selector. |
| `model` | Explicitly allow selection calls for any configured provider, including ACP. |

Explicit agents, one remaining candidate, and strong context affinity continue to skip selection. The dialogue interface retains its planner for conversation. Structured routing uses a 2,048-token context window and requests 64 output tokens from compatible HTTP providers, with neutral candidate IDs mapped back to real agent IDs in code. Large tasks bypass the selector without truncating requirements. Invalid replies fall back to ranking without repair calls.

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

A separate real integration check used the production executor with the local selector and a real Gemini worker. It produced the exact expected CSV bytes, returned `done`, charged **155 local routing tokens** and **24,041 frontier worker tokens**, in that historical run. The earlier ACP router used 22,800 tokens in a different scenario; these figures expose wrapper overhead but are not a controlled savings ratio.

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
