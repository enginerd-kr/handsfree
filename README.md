<div align="center">

# handsfree

**An agent orchestrator for Claude Code, Gemini CLI, and Codex — a single prompt input, routed to the ideal agent.**

A lightweight planning model orchestrates each turn, while specialized agents execute the tasks. Each agent maintains its own session memory, preventing redundant re-reading or re-explanation of context.

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

The result is extreme context efficiency: you state your intent once, and the optimal agent acts on it, building seamlessly upon its accumulated context.

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
handsfree                      # terminal UI
handsfree run "add a test"     # one turn, no UI
```

Simply describe your goal, and the planner automatically routes it to the most capable agent:

```
> fix the failing tests
```

You can also explicitly address an agent using `@`, and optionally specify a target model using `:` after its name:

```
> @claude summarise this file
> @codex:gpt-4o write a test first
```

Lines starting with `/` are interpreted as commands. `/agents` lists the active roster, `/help` displays all available commands, and you can extend this by adding custom markdown-defined commands in `.handsfree/commands/*.md` within your project directory.

The directory where you launch `handsfree` serves as the workspace—the single, sandboxed directory where all agents read and write.

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

Use the `/config` command to inspect active settings and their origins. Refer to `handsfree.config.example.json` for the complete configuration schema—all options have sensible built-in defaults.

## Development

```bash
pnpm typecheck
pnpm test
pnpm screenshots     # re-shoot every picture in this README, from the real TUI
```

## License

MIT
