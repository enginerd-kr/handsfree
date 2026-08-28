<div align="center">

# handsfree

**Run Claude Code, Gemini CLI and Codex at full power — without ever typing `--dangerously-skip-permissions`.**

A local model routes your work to frontier coding agents. handsfree owns every side effect they cause.

[![ci](https://github.com/enginerd-kr/handsfree/actions/workflows/ci.yml/badge.svg)](https://github.com/enginerd-kr/handsfree/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

</div>

<p align="center">
  <img src="docs/screens/turn.svg" alt="handsfree routing a task to claude: a thought, a read, a write, an allowed test run, and a refused git push" width="100%">
</p>

One line in. One agent picked. Every file it read, every file it wrote, every command it ran — approved or refused by handsfree, and written down.

---

## Why

Every frontier coding CLI ships a switch that turns its own approvals off. `--dangerously-skip-permissions`. `--yolo`. `danger-full-access`. Everyone flips it, because answering the same prompt four hundred times is not work.

handsfree deletes the reason to flip it.

The agents run in **their own default permission mode**. Where the bypass flag would have put an approval, handsfree puts a policy engine — and where the policy engine cannot decide, it puts you.

<p align="center">
  <img src="docs/screens/permission.svg" alt="claude asks to run node test.mjs; handsfree stops the turn and offers allow once or refuse" width="100%">
</p>

Those flags are not merely discouraged. A launch profile carrying one is **refused at config load**, and checked again immediately before `exec`.

## How

All three agents speak the [Agent Client Protocol](https://agentclientprotocol.com). handsfree is an ACP **client**: it starts each agent as a child process, answers its `session/request_permission` calls, and — because it also *implements* `fs/*` and `terminal/*` — it is the thing that actually reads the file, writes the file, and runs the command.

The agent asks. handsfree acts. There is no third path. An agent that stops for something other than permission — a question of its own, over `elicitation/create` — is put in front of you the same way.

```
        you
         │
  orchestration model ── routes, summarises. Never decides permissions.
         │
    ┌────┴─────────────────────────────────────────┐
    │  handsfree · ACP host                        │
    │    session/request_permission  → policy      │
    │    fs/read_text_file           → policy      │
    │    fs/write_text_file          → policy      │
    │    terminal/*                  → policy      │
    │    elicitation/create          → you         │
    └────┬──────────────┬──────────────┬───────────┘
   claude-agent-acp  gemini --acp   codex-acp
```

Agents work in a jail, and the jail is the directory you started handsfree in. The transcript is kept outside it, because an audit log an agent can edit is not an audit log.

## Install

```bash
pnpm install && pnpm build
```

You also need whichever agents you plan to use, each logged in with its own CLI:

| agent | launched as | log in with |
|---|---|---|
| claude | `npx -y @agentclientprotocol/claude-agent-acp` | `claude /login` |
| gemini | `gemini --acp` | `gemini` |
| codex | `npx -y @agentclientprotocol/codex-acp` | `codex login` |

And an orchestration model to do the routing. By default that is a local OpenAI-compatible endpoint (LM Studio, Ollama, llama.cpp) at `http://localhost:1234/v1` — a 12B model is plenty, because routing is small work. Set `orchestration.provider` to `"acp"` and one of the agents above does the routing instead, with no local endpoint at all.

Check the lot:

```bash
handsfree doctor
```

```
  ok    claude   claude-agent-acp 0.70.0
        launch: npx -y @agentclientprotocol/claude-agent-acp
        resume: session/load
        prompt: image, embeddedContext
        auth:   Log in with Claude Code
```

Adapters are third-party packages that move on their own schedule, so `doctor` performs a real handshake rather than a version check.

## Use

```bash
handsfree                      # terminal UI
handsfree run "add a test"     # one turn, no UI
handsfree serve --acp          # be an ACP agent, for an editor to drive
handsfree --sandbox            # an empty scratch workspace instead of this directory
```

**The directory you start in is the workspace.** That is the checkout the agents read and write, and it is also the boundary: the same policy engine that judges every request judges a path outside it as outside, whatever the agent was told. So `cd` to the project and start there — telling an agent in prose to go and work somewhere else is not a thing that can work, by design.

Two directories are refused rather than attached, because they are not projects: your home directory and the filesystem root. `--sandbox` is the empty workspace under `~/.handsfree/runs/<id>/workspace/`, kept for a turn that has no project to it. Under `handsfree serve --acp` the editor names the directory instead, and it is the editor's project.

## When an agent stops

An agent stops mid-turn for one of two reasons, and both of them end up in front of you.

**It wants permission.** The rules run first; only what they cannot settle is escalated — the `y`/`n` box in the screenshot above, one question at a time, in the order they arrived. Only `allow_once` is ever selected. Where an agent offers nothing but a standing approval, that is not quietly taken and not quietly refused: you are told in as many words that saying yes approves it for the rest of the session, and only your yes widens it.

**It has a question of its own.** Over `elicitation/create` an agent can ask before it guesses — which of two approaches, a name, a yes. handsfree advertises form mode, renders the form a field at a time, and hands the answers back into the same turn; `esc` is a refusal the agent is told about, which is not the same as nobody having been there. Switch it off with `capabilities.elicitation` and an agent that needs an answer has to end its turn to ask for one.

While either question is open the turn's clocks stop. An agent waiting on a person sends no updates and makes no progress, and a timer that cannot tell waiting from wedged would cancel the very turn that asked — so the idle deadline is held and the wall clock discounts the wait. The decision timeout (`policy.decisionTimeoutMs`, two minutes) is the one clock that does run, and a question nobody answers is refused. If the agent withdraws the request first, the question comes down with it rather than collecting an answer that has nowhere to land.

Who holds the seat depends on how handsfree was started: the terminal UI, the editor when it is `serve --acp`, or stderr for `handsfree run` at a terminal. Piped or in CI there is nobody, and every escalation is a denial.

---

## Name the agent. Name the model.

`@` at the start of a word opens the roster, and a line that leads with one goes to that agent instead of the planner.

A colon after the name picks the model: `@codex:luna rewrite the parser`.

The models on offer are **the agent's own answer**, asked for once at startup so the menu is there the moment the colon is. Each adapter is the one its CLI ships, so the roster it advertises is the CLI's roster and the model it comes up on is the CLI's default — nothing to configure, nothing to keep in sync.

A typed name is matched the way it is typed — the id exactly, then as a prefix, then anywhere in it — so `:luna` and `:opus` are enough. Several matches is an error naming them rather than a guess. The switch lands before the task is sent and sticks until another mention moves it. Ids are shown exactly as advertised, brackets and all: `opus[1m]`, `gpt-5.6-terra[max]`.

To start an agent somewhere other than its own default, name it in the profile:

```json
"codex": {
  "command": "npx",
  "args": ["-y", "@agentclientprotocol/codex-acp"],
  "model": "gpt-5.5"
}
```

`model` is optional and matched the same way. Every session with that agent is put on it as it opens — a resumed one included — and a name the agent will not take fails loudly rather than leaving a turn on a model nobody chose.

### Name the planner, too

One name in that roster is not an agent. `@orchestrator:claude:opus` moves the planner itself — the model that routes and summarises — to Claude on Opus, and it walks the same way as any address: `@orchestrator:` offers the agents, and the colon after one offers that agent's models.

```
@orchestrator:gemini:flash            plan on Gemini Flash from here on
@orchestrator:codex fix the tests     move it, and ask it that in the same line
```

The roll call under the prompt opens with it: a diamond rather than a dot, and the only entry spelled `agent:model`, because it is the only one that is not an agent. It fills while the planner is working — choosing the next step, or writing the answer — and empties once a task is out with an agent, whose own dot fills instead.

The move takes effect for the rest of the run, whichever way the config had it: a local endpoint is put down and the agent picks up the planning. `/agents` and `handsfree doctor` name whatever is planning now, and the config file is where the next run starts from — nothing is written back. The old planner's connection is closed as the new one takes over.

A name the agent will not take, one nobody configured, or one switched off is refused and the line stops there: what was asked for was a different planner, and running the work on the old one is not that. `orchestrator` is reserved as an agent id for the same reason a command file cannot be called `/exit`.

## Commands

A line that opens with a slash is a command. There are two kinds, and the difference is who answers.

**handsfree answers these itself** — no agent is woken, no turn is spent, and they work on a machine where nothing is configured yet, which is the machine where you want them most:

| | |
|---|---|
| `/help` | every command there is, and where the rest of them come from |
| `/config` | what handsfree is running with, and which files it read it from |
| `/agents` | the agents this run can delegate to, and which one is routing |
| `/clear` | forget the conversation and the screen with it; the agents are briefed from scratch |
| `/exit`, `/quit` | leave |

**You write the rest**, as markdown, in `.handsfree/commands/` beside your project or `~/.config/handsfree/commands/` for the ones you want everywhere. The project directory wins a name; the built-ins above win it from both, because a command file often arrives with somebody else's repository and `/exit` meaning anything other than leaving is not a thing a checkout gets to arrange. A sub-directory becomes a namespace: `commands/frontend/deploy.md` is `/frontend:deploy`.

```markdown
---
description: review a path and say what you find
argument-hint: "[path]"
arguments: path
---
Review $path against the diff below.

!`git diff --stat`

The conventions we hold to are in @CONVENTIONS.md.
```

`$ARGUMENTS` is everything after the command, `$1` and `$2` are the words of it, and a name listed under `arguments:` can be used directly. A body that asks for none of them still gets them, appended under `ARGUMENTS:` — so a command file can be plain prose and `/review src` will still mean something.

`` !`cmd` `` and `@file` run **before** the model sees anything, and go through the same policy engine an agent's own request does — the same allowlist, the same jail, the same output ceiling and deadline, the same line in the transcript:

```
> /review src/policy
  + run git diff --stat
  - run git push origin main
```

A refusal is written into the prompt where the output would have been, and the model is told plainly that it was refused rather than being handed a prompt with a hole in it. The allowlist below is the one that applies: `` !`git diff` `` runs, `` !`git commit` `` asks you first.

One thing worth knowing: they run against **the workspace** — the directory you started in, or the empty one under `~/.handsfree` if you passed `--sandbox`.

In the terminal UI, typing `/` opens the list. Escape closes the menu; a second escape still stops whatever is running.

## The policy engine

Three questions, one answer each, and every answer on the record.

```json
"policy": {
  "workspaceOnly": true,
  "fs":   { "read": "allow", "write": "allow", "outside": "deny", "followSymlinks": false },
  "exec": { "enabled": true, "mode": "allowlist", "otherwise": "ask", "shellOperators": "ask" },
  "escalation": ["user"]
}
```

- **`allow`** — it happens, and the transcript says so.
- **`deny`** — it does not, and the agent is told why. A refusal is final; asking again will not change it.
- **`ask`** — the turn stops and the question comes to you, as the screenshot under [Why](#why) shows.

`allow` is a list of token prefixes: `git status` matches `git status --short`, `ls` matches `ls` with anything after it. The built-in list is the reading half of a coding task plus the verbs that close the loop on a change — `ls cat head tail wc stat file pwd echo which tree diff grep rg`, `git status/diff/log/show/branch/blame`, and `pnpm`/`npm`/`yarn` test and build, `cargo`, `go`, `pytest`, `ruff check`, `mypy`, `make`. Writing your own `allow` replaces that list rather than adding to it. `find` is left off it on purpose: `-delete` and `-exec` make it a writing tool wearing a reader's name.

What the list does not name is `otherwise`, and out of the box `otherwise` is **you**. `git commit`, `pnpm install`, a script the agent wrote a moment ago — each is shown and waited on rather than refused, because a coding agent legitimately reaches past any list written in advance, and the question is who decides, not whether the list was complete. `shellOperators` is the same answer to a neighbouring question: a `|`, a `&&`, a `>` is where our reading of a script stops, so the script goes to you whole rather than being emulated. `sudo`, `mkfs` and `shutdown` are refused before either question is asked, and no approval reaches past that.

With nobody to ask — `handsfree run`, CI, a prompt nobody answers in time — every `ask` is a denial, so unattended runs stay exactly as tight as an allowlist. `"enabled": false` turns the lot off and makes handsfree a file-only host again. Commands are run directly rather than through a shell, and every path an agent names must resolve inside the workspace — a symlink pointing out of it is not a way around that.

Two things are deliberately absent: there is no `permissionMode`, `approvalMode` or `sandbox` setting per agent, and no way to express a bypass flag.

## Configuration

Settings are read from two files and layered, the project over the user:

```
./handsfree.config.json                 this checkout, and it wins
~/.config/handsfree/config.json         you, on this machine
```

Both are read, so a project file is a layer over the user's rather than a replacement for it: a checkout can pin the one thing it cares about — the agent it wants, an entry off the allowlist — without restating the endpoint, the proxy and the timeouts you set once for every project. Objects merge key by key, so naming `policy.exec.mode` leaves the rest of `policy` as you wrote it; anything else — a scalar, an array — is taken from the stronger file whole. Arrays are not concatenated on purpose: `policy.exec.allow` says what may run, and a layer that could only ever add to it is a layer that cannot say *not here*. An entry under `agents` is taken whole for the same reason — a launch line spliced from two files is a command nobody wrote.

Only what is present is layered, and the merged whole is validated once, so either file may be a fragment. `/config` names the files it read, in the order they won; so does `handsfree doctor`. See `handsfree.config.example.json`; everything has a default.

### The orchestration model

Both ways of running it sit side by side, and `provider` picks the live one:

```json
"orchestration": {
  "provider": "local",
  "local": { "baseURL": "http://localhost:1234/v1", "model": "google/gemma-3-12b" },
  "acp": { "agent": "claude", "model": "haiku" }
}
```

`local` speaks to any OpenAI-compatible endpoint. `acp` drives one of the configured `agents` over ACP in a connection of its own, separate from the sessions that do the work — its planning chatter never lands in a task's context, and it passes through the same policy engine as everything else. (The old top-level `llm` block is still read and treated as `orchestration.local`.)

Both name the model that plans: `local.model` is the id the endpoint serves, and `acp.model` is matched against the agent's own roster the way a `:model` mention is, so a prefix is enough. It is worth naming apart from the agents doing the work — routing and summarising is small, frequent work, and the model that is right for it is rarely the one you want editing your files. Left out, the planner takes the agent profile's `model`, and failing that whatever the agent comes up on.

### Behind a corporate proxy

Configure the proxy here rather than in the shell — agents are spawned directly, so shell aliases never reach them:

```json
"proxy": {
  "https": "http://proxy.corp:8080",
  "noProxy": "localhost,127.0.0.1,.corp.example"
}
```

Each key writes both spellings (`HTTPS_PROXY` and `https_proxy`) into every process handsfree starts. A key that is omitted inherits the shell's value; `""` removes the variable entirely — so `"proxy": { "http": "", "https": "", "all": "" }` means "no proxy for the agents, whatever the shell says". An agent profile's `env` overrides this block per agent, and a `null` value there removes an inherited variable:

```json
"agents": {
  "claude": { "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp"],
              "env": { "HTTPS_PROXY": null } }
}
```

Gemini authenticated by an API key needs that key in handsfree's own environment or in the profile's `env`: agents run in the workspace jail, and the gemini CLI reads `~/.gemini/.env` only from a directory its own trust list knows, which the jail never is.

## The transcript

One run, one record:

```
~/.handsfree/attached/<project>-<hash>/<id>/transcript.jsonl    working in your directory
~/.handsfree/attached/<project>-<hash>/<id>/sessions.json

~/.handsfree/runs/<id>/transcript.jsonl     --sandbox: the same two, beside the jail
~/.handsfree/runs/<id>/sessions.json
~/.handsfree/runs/<id>/workspace/           the jail — agents' cwd
```

The record is kept out here either way, never inside the directory being worked on, because an audit log an agent can edit is not an audit log. The UI renders it, the summary is written from it, and tests replay it — there is no second copy of what happened anywhere in the system. Runs older than `cleanupPeriodDays` are swept a beat after startup.

## Sessions

handsfree keeps one session per agent for the whole run, so a follow-up task builds on the previous one instead of replaying context through files. Where an adapter supports `session/load`, a restart rejoins the conversation rather than starting over.

## Debugging

```bash
handsfree --debug doctor       # diagnostics on stderr
HANDSFREE_DEBUG=1 handsfree run "…"
HANDSFREE_DEBUG=/tmp/hf.log handsfree
```

`--debug` (or a non-empty `HANDSFREE_DEBUG`) logs what the transcript cannot show: the exact command each agent is launched with, the environment it inherits, adapter stderr, handshake timing, and the orchestration endpoint. The TUI owns the terminal, so there it writes to a `handsfree-debug-<pid>.log` file and prints the path.

One pitfall it calls out explicitly, because it is invisible otherwise: agents are spawned directly, **not through a shell**, so aliases and functions from your rc files do not apply to them. Behind a corporate proxy use the config's `proxy` block instead — and note that `HTTP_PROXY=` in a shell sets the variable to an *empty string* rather than unsetting it, and that HTTPS traffic reads `HTTPS_PROXY`, not `HTTP_PROXY`.

## As an agent

`handsfree serve --acp` turns the whole thing around: an editor drives handsfree, handsfree drives the agents, and an escalated permission request travels up to the editor. A sub-agent's own question travels the same way, as an `elicitation/create` of ours — but only where the editor said at `initialize` that it renders forms; an editor that did not is left out of that seat rather than sent a question it would drop. The routing, the boundary and the gates are unchanged — only the occupant of the human seat differs.

## Development

```bash
pnpm typecheck
pnpm test
pnpm screenshots     # re-shoot every picture in this README
```

The suite runs against a scripted in-process ACP agent (`test/fake-agent.ts`), because the interesting cases — a refused command, a path escape, a turn that never ends — are precisely the ones a real adapter will not perform on request.

Both screenshots above are taken the same way. `pnpm screenshots` opens the real TUI on a headless terminal, drives it with keystrokes, and saves the frame ink actually drew as an SVG under `docs/screens/`. The agents are scripted; everything between the keystroke and the pixel — the planner, the policy engine, the renderer — is the shipping code, and the commands that do run, run for real.

## Licence

MIT
