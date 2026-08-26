# handsfree

A local model routes your work to frontier coding agents — Claude Code, Gemini CLI, Codex — and **handsfree owns every side effect they cause**.

The agents run in their own default permission mode. No `--dangerously-skip-permissions`, no `--yolo`, no `danger-full-access`. Where those flags would put an approval, handsfree puts a policy engine, and where the policy engine cannot decide, it puts you.

This works because all three agents speak the [Agent Client Protocol](https://agentclientprotocol.com). handsfree is an ACP **client**: it starts each agent as a child process, answers its `session/request_permission` calls, and — because it also *implements* `fs/*` and `terminal/*` — is the thing that actually reads the file, writes the file, and runs the command.

```
        you
         │
    local model ────── routes, summarises. Never decides permissions.
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

And a local OpenAI-compatible endpoint for the routing model (LM Studio, Ollama, llama.cpp), by default at `http://localhost:1234/v1`.

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

The local model is not in this path. It routes tasks and writes the summary; a small quantised model has no business deciding whether a command may run.

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
