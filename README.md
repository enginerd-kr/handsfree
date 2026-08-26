# handsfree

A chat TUI where a **local small LLM** orchestrates **frontier-model CLIs** — [Claude Code](https://claude.com/claude-code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), and [Codex CLI](https://github.com/openai/codex) — running headless. You describe a task; the local model decides whether to answer or delegate it, writes a task brief to a shared workspace, runs the CLI with minimum-scope permissions, and feeds the result back into the conversation.

```
you  › make a file called notes.txt saying hello world
task   claude #1: success
  hf  Done — notes.txt was created with "hello world".
```

## Why

- Your conversation stays on a **local model** (LM Studio, Ollama, llama.cpp — any OpenAI-compatible endpoint).
- Frontier models only see **self-contained task briefs**, and only when delegation is needed.
- Tasks share context **through files** in a per-session workspace (`context.md`, `tasks/<n>/brief.md`, `tasks/<n>/result.md`) — not through anyone's context window.

## Always reports back

A turn that delegated work **always** ends with a summary of what the agents did — file by file, failure by failure. handsfree asks the local model to write it, but never depends on that: if the model is slow, unreachable, or answers with JSON instead of prose, handsfree falls back to a report composed from the recorded task outcomes. Silence is treated as a bug, not an edge case.

## Permission model (no bypass, ever)

handsfree is built for environments where permission bypass is not acceptable. It never uses
`--dangerously-skip-permissions` (claude), `--yolo` (gemini), or
`--dangerously-bypass-approvals-and-sandbox` (codex) — those values are unrepresentable in the
config schema, and any attempt to smuggle one in via `extraArgs` fails config loading with an error.

The same applies one level down: blocking bypass flags would be pointless if the tool allowlist
could hand the agent a shell anyway, so `allowedTools` refuses shell, network and subagent tools
(`Bash`, `WebFetch`, `WebSearch`, `Task`, …) at config load. You can narrow the list, never widen it.

| Agent | Scope |
|---|---|
| claude | `--permission-mode acceptEdits`, `--allowedTools Read Write Edit Glob Grep` |
| gemini | `--approval-mode auto_edit` (file edits only; shell is denied) |
| codex | `-s workspace-write` OS sandbox, no network |

In headless mode a tool call that would need interactive approval is **denied, not prompted**. handsfree detects blocked outcomes, retries once with the task rephrased to file-only operations, and otherwise reports exactly what was denied — it never widens scope on its own.

## Setup

Requirements: Node >= 22, pnpm, at least one of `claude` / `gemini` / `codex` installed and logged in, and a local OpenAI-compatible LLM server.

```bash
pnpm install
pnpm build
node dist/index.js doctor     # preflight: endpoint + CLI auth
node dist/index.js            # chat TUI
```

Configuration (all optional): `./handsfree.config.json` (see `handsfree.config.example.json`), `~/.config/handsfree/config.json`, or env vars `HANDSFREE_LLM_BASE_URL`, `HANDSFREE_LLM_MODEL`, `HANDSFREE_LLM_API_KEY`, `HANDSFREE_WORKSPACE_ROOT`.

Headless / scripting:

```bash
node dist/index.js --headless -p "have claude create hi.txt saying hi"

# JSONL, one event object per line — for parsing rather than reading
node dist/index.js --headless --output-format json -p "..."
```

`--output-format text` (the default) prints readable `[task ...]` lines and abbreviates long
values; `json` emits one complete event per line (`workspace`, `assistant`, `task_started`,
`task_finished`, `error`, `turn_done`) with nothing truncated.

## Development

The project is developed in a **develop → e2e → verify** loop. E2e tests use **no mocks**: they run the real built app against a real local LLM endpoint and the real frontier CLIs, asserting on semantic outcomes (files created in a temp workspace).

CI runs `typecheck`, `test` and `build` on every push and pull request — never the e2e suite, which
needs a live endpoint and authenticated CLIs that a runner does not have.

```bash
pnpm test          # unit tests (fast; includes forbidden-flag guards)
pnpm e2e:tui       # visual TUI e2e in a pty (no LLM needed)
pnpm e2e:core      # local-LLM-only loop test (~seconds)
pnpm e2e:claude    # one real claude delegation
pnpm e2e:gemini
pnpm e2e:codex
pnpm e2e:smoke     # core + claude
pnpm e2e           # full suite, sequential
```

E2e requires a live endpoint (default `http://localhost:1234/v1`); the suite fails fast with instructions if it's missing. See `.env.e2e.example`. The TUI-only run (`pnpm e2e:tui`) is the exception — it drives slash commands locally and needs no endpoint.

Every e2e run writes a Playwright-style HTML report to `e2e-report/index.html` (`pnpm e2e:report` opens it): pass/fail per test, `.webp` screenshots taken at key moments, a looping animated-`.webp` recording of the whole terminal session, the final screen as text, and headless tests' stdout. On failure, the screen at the moment of failure is captured automatically.

## License

MIT — see [LICENSE](LICENSE).
