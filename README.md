<div align="center">

# handsfree

**An agent orchestrator for Claude Code, Gemini CLI and Codex — one line in, routed to whichever agent suits it.**

A small model plans each turn; the agents do the work, each keeping its own memory of the run so nothing gets re-read or re-explained.

[![ci](https://github.com/enginerd-kr/handsfree/actions/workflows/ci.yml/badge.svg)](https://github.com/enginerd-kr/handsfree/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
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

A coding agent is expensive to keep warm and wasteful to re-brief. handsfree keeps the expensive part — an agent's read files, its understanding of the code, what it just changed — alive in its own session for the whole run, and asks a small model to do only the cheap part: deciding which agent a task suits, and remembering a one-line ledger of what already happened.

The result is one thing said once. You say what you want; the right agent gets it, on top of everything it already knows.

## Install

```bash
pnpm install && pnpm build
```

You'll also need whichever agents you plan to use, each logged in with its own CLI (`claude /login`, `gemini`, `codex login`), and a model to do the routing — a local OpenAI-compatible endpoint by default, or one of the agents themselves.

```bash
handsfree doctor     # checks every agent and the routing model in one pass
```

## Use

```bash
handsfree                      # terminal UI
handsfree run "add a test"     # one turn, no UI
```

Just say what you want, and the planner picks who takes it:

```
> fix the failing tests
```

Address an agent yourself with `@`, and a model with `:` after its name:

```
> @claude summarise this file
> @codex:gpt-5.6 write a test first
```

A line starting with `/` is a command. `/agents` lists who's on the roster, `/help` lists the rest, and `.handsfree/commands/*.md` beside your project adds your own.

The directory you start handsfree in is the workspace — the one place agents read and write.

## Configuration

`handsfree.config.json`, project and user, layered. Name each agent's launch command, what it's for, and which model plans:

```json
"agents": { "codex": { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] } },
"roles":  { "codex": "methodical coding agent, good at tests and refactors" },
"orchestration": { "provider": "local", "local": { "baseURL": "http://localhost:1234/v1" } }
```

See `handsfree.config.example.json` — everything else has a sensible default.

## Development

```bash
pnpm typecheck
pnpm test
pnpm screenshots     # re-shoot every picture in this README, from the real TUI
```

## Licence

MIT
