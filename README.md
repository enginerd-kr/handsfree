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
   claude-code-acp   gemini --acp   codex-acp
```

## Install

```bash
pnpm install && pnpm build
```

You also need whichever agents you plan to use, each logged in with its own CLI:

| agent | launched as | log in with |
|---|---|---|
| claude | `npx -y @zed-industries/claude-code-acp` | `claude /login` |
| gemini | `gemini --experimental-acp` | `gemini` |
| codex | `npx -y @zed-industries/codex-acp -c model=gpt-5.5` | `codex login` |

And an orchestration model to do the routing. By default that is a local OpenAI-compatible endpoint (LM Studio, Ollama, llama.cpp) at `http://localhost:1234/v1`; set `orchestration.provider` to `"acp"` and one of the agents above does the routing instead, with no local endpoint at all.

Check the lot:

```bash
handsfree doctor
```

```
  ok    claude   @zed-industries/claude-code-acp 0.16.2
        launch: npx -y @zed-industries/claude-code-acp
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

## Commands

A line that opens with a slash is a command. There are two kinds, and the difference is who answers.

**handsfree answers these itself** — no agent is woken, no turn is spent, and they work on a machine where nothing is configured yet, which is the machine where you want them most:

| | |
|---|---|
| `/help` | every command there is, and where the rest of them come from |
| `/config` | what handsfree is running with, and which files it read it from |
| `/agents` | the agents this run can delegate to, and which one is routing |
| `/reset` | forget the conversation; the agents are briefed from scratch |
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

`` !`cmd` `` and `@file` are the interesting part. Both run **before** the model sees anything, which in any other tool would mean a markdown file in a repository you cloned quietly runs commands on your machine. Here they go through the same policy engine an agent's own request does — the same allowlist, the same jail, the same output ceiling and deadline, the same line in the transcript:

```
> /review src/policy
  + run git diff --stat
  - run git push origin main
```

A refusal is written into the prompt where the output would have been, and the model is told plainly that it was refused rather than being handed a prompt with a hole in it. Out of the box `policy.exec.enabled` is `false`, so every `` !`cmd` `` is refused until you turn it on and say what may run; `/help` says so at the bottom rather than leaving you to guess.

One thing worth knowing: they run against **the workspace**, which is the agents' jail — `~/.handsfree/runs/<id>/workspace/`, not your repository. That is the same directory the agents see, which is the point, but it does mean `` !`git diff` `` in the terminal UI is looking at their work rather than yours. Under `handsfree serve --acp` the editor's project *is* the workspace, and then it is looking at exactly what you would expect.

In the terminal UI, typing `/` opens the list. The arrows move through it, tab fills a command in, and enter sends the ones that want nothing further. Escape closes the menu; a second escape still stops whatever is running.

## Debugging

```bash
handsfree --debug doctor       # diagnostics on stderr
HANDSFREE_DEBUG=1 handsfree run "…"
HANDSFREE_DEBUG=/tmp/hf.log handsfree
```

`--debug` (or a non-empty `HANDSFREE_DEBUG`) logs what the transcript cannot show: the exact command each agent is launched with, the environment it inherits, adapter stderr, handshake timing, and the orchestration endpoint. The TUI owns the terminal, so there it writes to a `handsfree-debug-<pid>.log` file and prints the path; set `HANDSFREE_DEBUG` to a path to choose the file yourself.

One pitfall the log calls out explicitly, because it is invisible otherwise: agents are spawned directly, **not through a shell**, so aliases and functions from your rc files do not apply to them. An `alias claude="HTTP_PROXY= NO_PROXY= claude"` never fires — handsfree launches `npx @zed-industries/claude-code-acp`, which inherits handsfree's own environment. Behind a corporate proxy, use the config's `proxy` block (see Configuration) instead of the shell, and note that `HTTP_PROXY=` in a shell sets the variable to an *empty string* rather than unsetting it, and that HTTPS traffic reads `HTTPS_PROXY`, not `HTTP_PROXY`. The debug log prints each variable as set, `<empty>`, or unset — with proxy credentials masked — so you can see exactly what the child saw.

## The three gates

Every side effect an agent causes arrives through one of three calls, and each is judged by the same rules.

**`session/request_permission`** — the agent wants to use one of its own tools. handsfree translates the tool call into the same terms as the other gates and applies the same policy. Two invariants:

- only `allow_once` is ever selected. A standing approval is a decision about work nobody has seen yet;
- if the agent offers no single-use option, the request is **cancelled**, not widened to fit.

**`fs/read_text_file` and `fs/write_text_file`** — handsfree reads and writes on the agent's behalf, which is where the workspace boundary stops being a promise. Paths are checked after resolution, not as strings: `/ws/../etc/passwd` and a symlink pointing out of the workspace are both refused, and a write either lands whole or not at all.

**`terminal/*`** — off by default. Turn it on and handsfree owns every command: it parses the argv, checks it against an allowlist, forces the working directory, strips `LD_PRELOAD`-style environment variables, caps the output, and kills the process group on timeout. A `sh -c` script is unwrapped and judged for what it would actually run; a pipe or a `$(…)` is a verdict of its own, not something to emulate.

The point of turning it on is not convenience. An agent that cannot use our terminal falls back to its own shell, where all we ever see is the permission request — so the choice is between commands we mediate and commands we merely hear about.

### What each agent actually does

Adapters differ more than the protocol suggests, and the differences decide what handsfree can allow:

| | claude-code-acp 0.16.2 | gemini `--experimental-acp` | codex-acp 0.16.0 |
|---|---|---|---|
| file reads/writes | through `fs/*` | through `fs/*` | its own; asks first, then writes |
| permission requests | no `kind`, no `locations`; file in `rawInput` | `kind` and `locations` present | `kind` and `locations` present |
| shell commands | uses `terminal/*` when offered | its own shell; command only in the title | its own shell; full argv in `rawInput` |
| asks before | every tool call | every tool call | anything that changes or escapes |
| `session/load` | yes | no | yes |

Where an agent names its command only in a human-readable title, handsfree refuses it — approving would mean approving whatever that agent's own shell decides to run, which is exactly what the allowlist exists to prevent. In practice that means **gemini can create and edit files but cannot run commands** under handsfree, and it will say so plainly when asked to.

codex is the opposite case. It never calls `fs/*` or `terminal/*`, so handsfree does not perform its work — but it states the whole argv as an array in `rawInput`, so the allowlist judges what it would actually run, and it names the file it would edit in `locations`, so the boundary applies to that path. **codex can both edit files and run allowlisted commands**, at the cost of being approved rather than mediated: the write is codex's, and what handsfree checked was codex's account of it. The two also draw the line in different places — codex asks before anything that changes the workspace or leaves it, and reads and lists without asking, so a plain `ls` is a command handsfree never sees.

Its model is pinned in the launch profile for the same reason gemini's is. codex-acp bundles its own Codex core and otherwise reads the model out of `~/.codex/config.toml`, where the separately-updated CLI has usually written a newer one; the turn then fails on the far side with *"requires a newer version of Codex"*. Change the pin with `-c model=…`, but note that a ChatGPT account refuses every model named explicitly except the one the bundled core already knows.

### How a decision is made

```
rules  →  human  →  deny
```

Rules are deterministic and run first. Anything they cannot settle is escalated. An escalation that nobody answers — no UI attached, no reply within the timeout, a prompt that throws — is a denial. There is no path through the policy engine that ends in an unrecorded yes.

The orchestration model is not in this path. It routes tasks and writes the summary; whether it is a small quantised model or a frontier agent, it has no business deciding whether a command may run.

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
  "claude": { "command": "npx", "args": ["-y", "@zed-industries/claude-code-acp"],
              "env": { "HTTPS_PROXY": null } }
}
```

Two things are deliberately absent: there is no `permissionMode`, `approvalMode` or `sandbox` setting per agent, and no way to express a bypass flag. Launch arguments are checked at config load and again immediately before `exec`.

## Sessions

handsfree keeps one session per agent for the whole run, so a follow-up task builds on the previous one instead of replaying context through files. Where an adapter supports `session/load`, a restart rejoins the conversation rather than starting over.

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
