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
| codex | `npx -y @zed-industries/codex-acp` | `codex login` |

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

## Debugging

```bash
handsfree --debug doctor       # diagnostics on stderr
HANDSFREE_DEBUG=1 handsfree run "…"
HANDSFREE_DEBUG=/tmp/hf.log handsfree
```

`--debug` (or a non-empty `HANDSFREE_DEBUG`) logs what the transcript cannot show: the exact command each agent is launched with, the environment it inherits, adapter stderr, handshake timing, and the orchestration endpoint. The TUI owns the terminal, so there it writes to a `handsfree-debug-<pid>.log` file and prints the path; set `HANDSFREE_DEBUG` to a path to choose the file yourself.

One pitfall the log calls out explicitly, because it is invisible otherwise: agents are spawned directly, **not through a shell**, so aliases and functions from your rc files do not apply to them. An `alias claude="HTTP_PROXY= NO_PROXY= claude"` never fires — handsfree launches `npx @zed-industries/claude-code-acp`, which inherits handsfree's own environment. Behind a corporate proxy, set or clear the variables where handsfree can see them (in the shell that starts handsfree, or per agent via the profile's `env` in config), and note that `HTTP_PROXY=` sets the variable to an *empty string* rather than unsetting it, and that HTTPS traffic reads `HTTPS_PROXY`, not `HTTP_PROXY`. The debug log prints each variable as set, `<empty>`, or unset — with proxy credentials masked — so you can see exactly what the child saw.

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
| file reads/writes | through `fs/*` | through `fs/*` | through `fs/*` |
| permission requests | no `kind`, no `locations`; file in `rawInput` | `kind` and `locations` present | — |
| shell commands | uses `terminal/*` when offered | its own shell; command only in the title | — |
| `session/load` | yes | no | yes |

Where an agent names its command only in a human-readable title, handsfree refuses it — approving would mean approving whatever that agent's own shell decides to run, which is exactly what the allowlist exists to prevent. In practice that means **gemini can create and edit files but cannot run commands** under handsfree, and it will say so plainly when asked to.

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

Drop a `handsfree.config.json` in the working directory or at `~/.config/handsfree/config.json`. See `handsfree.config.example.json`; everything has a default.

The orchestration model is picked by `orchestration.provider`, and both ways of running it sit side by side in the config:

```json
"orchestration": {
  "provider": "local",
  "local": { "baseURL": "http://localhost:1234/v1", "model": "google/gemma-3-12b" },
  "acp": { "agent": "claude" }
}
```

`local` speaks to any OpenAI-compatible endpoint. `acp` drives one of the configured `agents` over ACP in a connection of its own, separate from the sessions that do the work — its planning chatter never lands in a task's context, and it passes through the same policy engine as everything else. (The old top-level `llm` block is still read and treated as `orchestration.local`.)

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
