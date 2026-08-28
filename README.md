# handsfree

An orchestration model — a local model by default, or a frontier agent over ACP — routes your work to frontier coding agents — Claude Code, Gemini CLI, Codex — and **handsfree owns every side effect they cause**.

The agents run in their own default permission mode. No `--dangerously-skip-permissions`, no `--yolo`, no `danger-full-access`. Where those flags would put an approval, handsfree puts a policy engine, and where the policy engine cannot decide, it puts you.

This works because all three agents speak the [Agent Client Protocol](https://agentclientprotocol.com). handsfree is an ACP **client**: it starts each agent as a child process, answers its `session/request_permission` calls, and — because it also *implements* `fs/*` and `terminal/*` — is the thing that actually reads the file, writes the file, and runs the command.

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
    └────┬──────────────┬──────────────┬───────────┘
   claude-agent-acp  gemini --acp   codex-acp
```

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

And an orchestration model to do the routing. By default that is a local OpenAI-compatible endpoint (LM Studio, Ollama, llama.cpp) at `http://localhost:1234/v1`; set `orchestration.provider` to `"acp"` and one of the agents above does the routing instead, with no local endpoint at all.

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
```

## Naming the agent, and the model

`@` at the start of a word opens the roster, and a line that leads with one goes to that agent instead of the planner. A colon after the name picks the model: `@codex:luna rewrite the parser`. Arrows move through either menu, tab or enter fills one in, escape closes it.

The models on offer are the agent's own answer, asked for once at startup so the menu is there the moment the colon is. Each adapter above is the one its CLI ships, so the roster it advertises is the CLI's roster and the model it comes up on is the CLI's default — there is nothing to configure and nothing to keep in sync.

A typed name is matched against that roster the way it is typed — the id exactly, then as a prefix, then anywhere in it — so `:luna` and `:opus` are enough. Several matches is an error naming them rather than a guess. The switch lands before the task is sent and sticks until another mention moves it. Ids are shown exactly as advertised, brackets and all: `opus[1m]`, `gpt-5.6-terra[max]`.

To start an agent somewhere other than its own default, name it in the profile:

```json
"codex": {
  "command": "npx",
  "args": ["-y", "@agentclientprotocol/codex-acp"],
  "model": "gpt-5.5"
}
```

`model` is optional and matched the same way. Every session with that agent is put on it as it opens — a resumed one included — and a name the agent will not take fails loudly rather than leaving a turn on a model nobody chose. An agent that offers no model selection over ACP says so in place of the menu.

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

A refusal is written into the prompt where the output would have been, and the model is told plainly that it was refused rather than being handed a prompt with a hole in it. Out of the box `policy.exec.enabled` is `false`, so every `` !`cmd` `` is refused until you turn it on and say what may run.

One thing worth knowing: they run against **the workspace**, which is the agents' jail — `~/.handsfree/runs/<id>/workspace/`, not your repository. Under `handsfree serve --acp` the editor's project *is* the workspace.

In the terminal UI, typing `/` opens the list. Escape closes the menu; a second escape still stops whatever is running.

## Configuration

Drop a `handsfree.config.json` in the working directory or at `~/.config/handsfree/config.json`. See `handsfree.config.example.json`; everything has a default.

The orchestration model is picked by `orchestration.provider`, and both ways of running it sit side by side:

```json
"orchestration": {
  "provider": "local",
  "local": { "baseURL": "http://localhost:1234/v1", "model": "google/gemma-3-12b" },
  "acp": { "agent": "claude" }
}
```

`local` speaks to any OpenAI-compatible endpoint. `acp` drives one of the configured `agents` over ACP in a connection of its own, separate from the sessions that do the work — its planning chatter never lands in a task's context, and it passes through the same policy engine as everything else.

Behind a corporate proxy, configure the proxy here rather than in the shell — agents are spawned directly, so shell aliases never reach them:

```json
"proxy": {
  "https": "http://proxy.corp:8080",
  "noProxy": "localhost,127.0.0.1,.corp.example"
}
```

Each key writes both spellings (`HTTPS_PROXY` and `https_proxy`) into every process handsfree starts. A key that is omitted inherits the shell's value; `""` removes the variable entirely. An agent profile's `env` overrides this block per agent, and a `null` value there removes an inherited variable:

```json
"agents": {
  "claude": { "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp"],
              "env": { "HTTPS_PROXY": null } }
}
```

Gemini authenticated by an API key needs that key in handsfree's own environment or in the profile's `env`: agents run in the workspace jail, and the gemini CLI reads `~/.gemini/.env` only from a directory its own trust list knows, which the jail never is.

Gemini authenticated by an API key needs that key in handsfree's own environment or in the profile's `env`: agents run in the workspace jail, and the gemini CLI reads `~/.gemini/.env` only from a directory its own trust list knows, which the jail never is.

Two things are deliberately absent: there is no `permissionMode`, `approvalMode` or `sandbox` setting per agent, and no way to express a bypass flag. Launch arguments are checked at config load and again immediately before `exec`.

## The transcript

One run, one record:

```
~/.handsfree/runs/<id>/transcript.jsonl     every update, every decision
~/.handsfree/runs/<id>/sessions.json        agent session ids, for resuming
~/.handsfree/runs/<id>/workspace/           the jail — agents' cwd
```

The transcript sits *above* the workspace, because an audit log an agent can edit is not an audit log. The UI renders it, the summary is written from it, and tests replay it — there is no second copy of what happened anywhere in the system.

## Configuration

Settings are read from two files and layered, the project over the user:

```
./handsfree.config.json                 this checkout, and it wins
~/.config/handsfree/config.json         you, on this machine
```

Both are read, so a project file is a layer over the user's rather than a replacement for it: a checkout can pin the one thing it cares about — the agent it wants, an entry off the allowlist — without restating the endpoint, the proxy and the timeouts you set once for every project. Objects merge key by key, so naming `policy.exec.mode` leaves the rest of `policy` as you wrote it; anything else — a scalar, an array — is taken from the stronger file whole. Arrays are not concatenated on purpose: `policy.exec.allow` says what may run, and a layer that could only ever add to it is a layer that cannot say *not here*. An entry under `agents` is taken whole for the same reason — a launch line spliced from two files is a command nobody wrote.

Only what is present is layered, and the merged whole is validated once, so either file may be a fragment. `/config` names the files it read, in the order they won; so does `handsfree doctor`. See `handsfree.config.example.json`; everything has a default.

The orchestration model is picked by `orchestration.provider`, and both ways of running it sit side by side in the config:

```json
"orchestration": {
  "provider": "local",
  "local": { "baseURL": "http://localhost:1234/v1", "model": "google/gemma-3-12b" },
  "acp": { "agent": "claude" }
}
```

`local` speaks to any OpenAI-compatible endpoint. `acp` drives one of the configured `agents` over ACP in a connection of its own, separate from the sessions that do the work — its planning chatter never lands in a task's context, and it passes through the same policy engine as everything else. (The old top-level `llm` block is still read and treated as `orchestration.local`.)

Behind a corporate proxy, configure the proxy here rather than in the shell — agents are spawned directly, so shell aliases never reach them:

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

Two things are deliberately absent: there is no `permissionMode`, `approvalMode` or `sandbox` setting per agent, and no way to express a bypass flag. Launch arguments are checked at config load and again immediately before `exec`.

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

`handsfree serve --acp` turns the whole thing around: an editor drives handsfree, handsfree drives the agents, and an escalated permission request travels up to the editor. The routing, the boundary and the gates are unchanged — only the occupant of the human seat differs.

## Development

```bash
pnpm typecheck
pnpm test
```

The suite runs against a scripted in-process ACP agent (`test/fake-agent.ts`), because the interesting cases — a refused command, a path escape, a turn that never ends — are precisely the ones a real adapter will not perform on request.

## Licence

MIT
