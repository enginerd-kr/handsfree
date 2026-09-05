<div align="center">

# handsfree

**A token-aware multi-agent tool for Claude Code, Gemini CLI, and Codex, with a lightweight router and reusable worker sessions.**

A lightweight model selects workers when needed, while specialized agents execute the tasks. Reusable sessions and compact handoffs reduce repeated setup; the host tracks usage and stale context.

[![ci](https://github.com/enginerd-kr/handsfree/actions/workflows/ci.yml/badge.svg)](https://github.com/enginerd-kr/handsfree/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

</div>

<p align="center">
  <img src="docs/screens/welcome.svg" alt="handsfree's opening frame: a greeting, and five example lines — a plain request, the planner addressed, an agent, an agent on a model, and a command" width="100%">
</p>

<p align="center">
  <img src="docs/screens/turn.svg" alt="handsfree routing a task to claude: a thought, a read, a write, an allowed test run, and a refused git push" width="49%">
  <img src="docs/screens/permission.svg" alt="claude asks to run node test.mjs; handsfree stops the turn and offers allow once or refuse" width="49%">
</p>

## Why

Coding agents are expensive to initialize and wasteful to re-brief. `handsfree` preserves the stateful, context-heavy components—such as read files, codebase comprehension, and active modifications—within dedicated agent sessions throughout the run. It delegates the lower-cost tasks of routing and state-keeping to a lightweight planning model, which decides the appropriate agent for each step and maintains a minimal, high-level ledger of the conversation.

The structured execution path preserves the original task and constraints in code. Explicit routing skips the planning model; otherwise code ranks a small candidate set and consults the router only when needed. Reports stay short, and full results remain available on demand. Token savings and task quality can be compared with the included benchmark; session reuse alone does not guarantee lower billed usage.

## Use as a multi-agent tool

```bash
handsfree serve --mcp --permission-mode acceptEdits
handsfree task '{"task":"Review the parser","kind":"inspect","agent":"claude"}'
```

Run from the project directory. MCP exposes `delegate`, `batch`, `read_result`, and `usage`. The same executor handles structured CLI requests and the conversation's delegated work. MCP is loaded only when selected.

```json
{
  "task": "Fix empty input handling",
  "kind": "change",
  "constraints": ["Preserve the legacy flag"],
  "acceptanceCriteria": ["Existing tests and the empty-input regression pass"],
  "files": ["src/parser.ts"],
  "budget": { "maxTokens": 20000 },
  "requestId": "parser-empty-input-1"
}
```

Results include task status, a short summary, blockers, artifacts, verification provenance, token usage, and a `resultRef`. Reusing a request ID returns its recorded result. An interrupted request is not automatically rerun. Fetch full details with `read_result` when the summary is insufficient. Batch requests declare dependencies; independent inspections may overlap while changes run exclusively.

See [execution contracts, budgets, and operating limits](docs/execution.md) for configuration and examples.

## Install

```bash
pnpm install && pnpm build
```

You'll also need whichever CLI agents you plan to use, each authenticated locally (e.g., via `claude /login`, `gemini`, or `codex login`), and an LLM to handle routing. By default, `handsfree` expects a local OpenAI-compatible endpoint, but you can also use one of the CLI agents themselves for routing.

```bash
handsfree doctor     # checks every agent and the routing model in one pass
```

## Use

```bash
handsfree                                        # terminal UI
handsfree run "add a test"                       # one turn, no UI
handsfree run --permission-mode bypass "..."     # one turn, nothing asked
```

Simply describe your goal, and the dialogue planner routes it to an agent. Each step either answers you or calls `agent` with a brief and reads back a short report. The `task_result` tool retrieves additional details when needed. Use the structured interface above to preserve explicit requirements without planner rewriting.

```
> fix the failing tests
```

You can also explicitly address an agent using `@`, and optionally specify a target model using `:` after its name:

```
> @claude summarise this file
> @codex:gpt-4o write a test first
```

Lines starting with `/` are interpreted as commands. `/agents` lists the active roster, `/cost` shows what the run has spent in tokens — on planning, and on each agent's turns as its CLI counted them — and how much of the agents' replies reached the planner, `/help` displays all available commands, and you can extend this by adding custom markdown-defined commands in `.handsfree/commands/*.md` within your project directory.

Above the roll call, a line of its own keeps a running count by model, in the order they were first used: `gemini:gemini-3.1-flash-lite 3.2k · claude-fable-5-1 12k · gpt-5.6 4.1k`. It is by model rather than by agent because the roll call shows the model each agent is on *now*, and you move that mid-run with `@agent:model` — a figure stays with the model that earned it. In the conversation, each task closes on what it cost and each of handsfree's own replies on what the orchestrator's calls cost. The figures are the agents' own — claude and codex count in the prompt response, gemini in its `_meta.quota` — and a `≈` marks an orchestrator figure handsfree had to estimate from characters because its endpoint gave none.

File, command, and tool permission requests routed through the ACP host are judged by its policy, and unresolved requests are put to you. Some adapters execute native tools without host permission requests; see the [live adapter findings](docs/live-use-cases.md) for the observed limits. Shift+Tab cycles how much of that you want to see: **ask** (the default; every question comes to you, every time), **accept edits** (reads and edits inside the workspace go through, commands still ask), and **bypass** (everything is allowed, including what the settings would refuse — the equivalent of a coding agent's skip-permissions flag, so use it in a checkout you can throw away). The mode lasts for the session and is never written to your settings; the last line under the prompt always shows it, `/config` prints it, and every decision the mode made is marked as the mode's in the transcript. `handsfree run` takes `--permission-mode acceptEdits` or `bypass` to start a headless turn in one, and an editor driving `handsfree serve --acp` is offered the same three as the session's modes.

The directory where you launch `handsfree` serves as the workspace. Host-mediated file operations are restricted to it; isolation of adapter-native operations depends on the adapter or an external sandbox.

## Supported agents

| agent | launched as | log in with |
|---|---|---|
| claude | `npx -y @agentclientprotocol/claude-agent-acp` | `claude /login` |
| gemini | `gemini --acp` | `gemini` |
| codex | `npx -y @agentclientprotocol/codex-acp` | `codex login` |

Any other agent that speaks ACP works the same way — add it under `agents` in the settings file and it joins the roster.

## Settings

Configuration is loaded from two locations and layered, with project-specific settings taking precedence over user-level configurations:

```
./handsfree.config.json                 Project-level configuration (committed/specific to workspace)
~/.config/handsfree/config.json         User-level global configuration (specific to your machine)
```

```json
"agents": { "codex": { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] } },
"roles":  { "codex": "methodical coding agent, good at tests and refactors" },
"orchestration": { "provider": "local", "local": { "baseURL": "http://localhost:1234/v1" } }
```

Agents are spawned directly, not through a shell, so aliases and rc-file tricks never reach them. Behind a corporate proxy, put the variables in the top-level `env` block under their own names — every agent starts with them, and `null` removes one the shell set:

```json
"env": {
  "HTTPS_PROXY": "http://proxy.corp:8080",
  "NO_PROXY": "localhost,127.0.0.1",
  "NODE_EXTRA_CA_CERTS": "/etc/ssl/certs/corp-ca.pem",
  "ALL_PROXY": null
}
```

Use the `/config` command to inspect active settings and their origins. Refer to `handsfree.config.example.json` for the complete configuration schema—all options have sensible built-in defaults.

## Development

```bash
pnpm typecheck
pnpm test
pnpm benchmark       # deterministic simulation; no model calls
pnpm benchmark --live # same artifact checks with the configured worker/model
pnpm screenshots     # re-shoot every picture in this README, from the real TUI
```

The benchmark compares direct, conversational, and structured execution on identical isolated fixtures. It reports artifact success, total/frontier tokens, planning overhead, failed calls, estimation gaps, and latency. Simulation results measure the orchestration path, not real model quality or billing. Live runs enforce a 60,000-token run budget per mode and a 24,000-token per-call budget; reported CLI usage may exceed these before cancellation is possible.

## License

MIT
