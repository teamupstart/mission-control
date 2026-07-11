# AI Harness

A local, auto-refreshing dashboard for the Claude Code / Codex sessions running
across your **wezterm tabs** and **tmux sessions**. See every agent at a glance,
act on any of them, and let an agent push a **diff or plan** to you for review -
and get your decision back.

<!-- screenshot: docs/dashboard.png -->

## What it does

- **Discovers** every running `claude` / `codex` session by walking process →
  controlling TTY → terminal pane. No per-session setup required.
- **Names** each session by its **tmux session name**, else its **wezterm tab
  title**, else the repo folder.
- **Live** via Server-Sent Events - the grid updates as sessions start, work,
  go idle, need input, or exit. No polling from the browser.
- **Acts** on a session: send it a message, focus its tab, or kill it.
- **Reviews**: an instrumented agent can push a diff, a markdown plan, or a
  question into the dashboard and block until you approve / request changes /
  answer - your decision flows straight back to the agent.
- **Dispatches** new agents: pick a repo, describe a task, and it launches an
  agent in its own isolated worktree + detached tmux session (or queues it in a
  backlog for later).
- **Reports** the fleet's bearings: who needs you, who's working, what's idle,
  the backlog, and recent outcomes - as a panel, JSON, or markdown digest.

## Quick start

```sh
make init          # one-time bootstrap (deps, build, hooks, treehouse + no-mistakes)
make dev           # daemon + Vite, open http://127.0.0.1:5173
```

`make init` is idempotent - it installs dependencies, builds, wires the Claude
hooks, makes sure [treehouse](#isolated-worktrees-per-session-treehouse) and
[no-mistakes](#no-mistakes) are installed, and gates this repo. If you'd rather
do the minimum by hand:

```sh
npm install
npm run dev        # daemon + Vite, open http://127.0.0.1:5173
```

Discovery works immediately - your live sessions show up with coarse grey
"running" status. To light up precise **working / idle / needs-input** states
(blue / green / amber) and the review channel, add the two optional integrations
below. Note the hooks only take effect in sessions started *after* you install
them (see [Precise status](#precise-status-claude-hooks)).

For a production run (daemon serves the built UI on one port):

```sh
npm run build
npm start          # http://127.0.0.1:7317
```

To run it always, as a login LaunchAgent (macOS):

```sh
npm run install-service          # start now + on login
npm run install-service -- --uninstall
```

## How it works

Three layers, most-to-least automatic:

| Layer | Setup | Gives you |
|-------|-------|-----------|
| **Passive discovery** | none | inventory + names + branch + uptime, live |
| **Claude hooks** | `npm run install-hooks` | precise state (working / idle / needs-input) + activity |
| **MCP review channel** | `claude mcp add …` (see below) | agents push diffs / plans / questions for you to decide |

One long-lived **daemon** (`src/server`) serves the React SPA (`src/web`) plus a
JSON API and an SSE stream on `127.0.0.1:7317`. A ~1.5s poller sweeps
`ps` + `wezterm cli list` + `tmux list-panes` and reconciles an in-memory
registry that broadcasts changes over SSE. Reviews and dispatched tasks are
persisted in SQLite (`node:sqlite`).

### Precise status (Claude hooks)

Passive discovery can tell a session is *alive*, but not whether the agent is
actively working, sitting idle, or waiting on you. Claude Code **hooks** close
that gap: a tiny bridge reports each lifecycle event to the daemon so every card
shows a live, precise state and a one-line activity.

**1. Install** (idempotent - it merges into `settings.json` in place, rewriting
only the hook arrays it changes, so your other settings, your own hooks, and
even comments are preserved; re-running when nothing changed doesn't touch the
file):

```sh
npm run install-hooks
```

Expected output:

```
Wired AI Harness hooks into /Users/you/.claude/settings.json
  events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, PreCompact, SessionEnd
  script: /Users/you/workspace/ai-harness/hooks/harness-hook.mjs
```

This adds one `command` hook per event to `~/.claude/settings.json`, each running
`hooks/harness-hook.mjs` with the event name. The bridge is fast, writes nothing
to stdout, swallows every error, and always exits 0, so a hook never blocks or
fails the agent even when the daemon is down.

**2. Start a new Claude Code session.** Claude reads hook config when a session
starts, so **sessions already running when you install won't report until you
restart them.** This is the #1 reason a busy agent is stuck on grey "running"
right after installing - the fix is simply a fresh session (or a full Claude
restart), not a code change.

**3. Verify.** In a new session, run anything; its card should flip from grey
**running** to blue **working** within ~1s. Or ask the daemon directly:

```sh
curl -s http://127.0.0.1:7317/api/sessions | grep -o '"instrumented":[a-z]*'
# "instrumented":true  once a session has reported at least one event
```

**Uninstall** (removes only our entries, leaves your other hooks intact):

```sh
npm run install-hooks -- --uninstall
```

<details>
<summary>What it writes to <code>settings.json</code></summary>

Tool events (`PreToolUse`, `PostToolUse`) get a `"*"` matcher; the rest match
every invocation. Paths are absolute (your `node` and this repo):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command",
          "command": "\"/usr/local/bin/node\" \"/Users/you/workspace/ai-harness/hooks/harness-hook.mjs\" PreToolUse" }
      ]}
    ],
    "Stop": [
      { "hooks": [
        { "type": "command",
          "command": "\"/usr/local/bin/node\" \"/Users/you/workspace/ai-harness/hooks/harness-hook.mjs\" Stop" }
      ]}
    ]
    // ...one group per event: SessionStart, UserPromptSubmit, PostToolUse,
    //    Notification, SubagentStop, PreCompact, SessionEnd
  }
}
```

Each fired hook POSTs `{ event, sessionId, cwd, env }` to
`http://127.0.0.1:7317/hooks/<event>` with the `~/.ai-harness/token`. The daemon
binds it to the right card via the terminal pane env (`TMUX_PANE` /
`WEZTERM_PANE`) and maps the event to a state (see the table below).

</details>

### Session status colors

Each card's status badge and its left edge stripe encode the session's state:

| Color | State | Meaning |
|-------|-------|---------|
| 🔵 blue | **working** | agent is actively running a prompt or tool |
| 🟢 green | **idle** | alive, waiting at an idle prompt |
| 🟠 amber | **needs input / needs review** | the agent (or a review item) is blocked on you |
| ⚪ grey | **running** | alive, but precise state unknown - hooks aren't reporting |
| ⚫ dim | **exited** | the process is gone |

Blue / green / amber require the **Claude hooks** above. Without them (or before
you restart a session) every card shows grey **running**. The small colored dot
next to each title is *not* a status - it's the agent's brand color (terracotta
for Claude Code, green for Codex).

### Review channel (MCP)

```sh
npm run build                    # builds the MCP server bundle
claude mcp add -s user ai-harness -- node /ABSOLUTE/PATH/dist/mcp/server.mjs
```

(`npm run install-hooks` prints the exact command with your paths.)

This registers a stdio MCP server (`src/mcp/server.ts`) that each Claude session
launches. It exposes four tools:

- `share_plan(title, plan)` - show a markdown plan (non-blocking)
- `request_review(title, diff)` - show a diff and **block** for approve / changes
- `request_input(question)` - ask a question and **block** for the answer
- `report_status(activity)` - update the session's activity line

Because the MCP server is a child of the agent, it inherits the terminal env and
binds every call to the correct session automatically.

## Dispatch a crewmate

The dashboard isn't just a mirror - you can launch new agents from it. Click **＋
Dispatch**, pick a repo, describe the task, and the daemon:

1. provisions an **isolated worktree** for the task (a pooled
   [treehouse](#isolated-worktrees-per-session-treehouse) tree when the repo opted in,
   else a plain `git worktree` on a fresh `harness/…` branch - so a crewmate never shares
   a working tree with another session),
2. launches the agent (`claude`/`codex`) in a **detached tmux session** rooted there, and
3. injects your task as its first prompt once passive discovery binds the session.

The new session then shows up on the grid like any other, with an **intent chip** naming
what it's working on. It's headless until you want it - click **Focus** on the card to open
it in a tab. Choose **Add to backlog** instead of **Dispatch now** to queue a task without
launching it yet.

Every dispatched task is a durable record (repo, intent, kind, worktree, branch, outcome)
persisted in SQLite, so the backlog and a running crew's intent survive a daemon restart.
Set `HARNESS_CLAUDE_BIN` / `HARNESS_CODEX_BIN` if the agent CLI isn't on the daemon's PATH.

## Fleet report (bearings)

Click **Report** for a one-look snapshot of the whole fleet, assembled from the same live
data the grid shows: **who needs you** (needs-input, pending reviews, parked no-mistakes
gates), **who's working** (with their intent + activity), **what's idle**, the **backlog**,
and **recent outcomes**. Dispatch a queued task or drop it right from the panel, and **Mark
done** a running task with its outcome (e.g. "opened PR #123") to close the loop. **Copy as
markdown** yields a paste-able digest (also at `GET /api/report.md`; JSON at `GET
/api/report`).

## Alerts & AFK mode

So you don't have to watch the grid, the dashboard can **alert you when the fleet
needs you**. The daemon already streams every attention event over SSE; the browser
turns those into a **desktop (Chrome) notification + a short sound** the moment a
session goes to `needs-input`, a review lands, a no-mistakes gate parks, or a
dispatched task fails. It's zero extra tokens - the daemon (not an LLM) does the
watching - and there's no phone/SMS piece; it's the open dashboard tab that alerts.

Open the **🔔 Alerts** control in the top bar to **Enable desktop alerts** (grants the
browser Notification permission and unlocks the chime), toggle **Sound**, and flip
**AFK mode**. AFK also alerts on sessions going idle and tasks finishing, and sends a
periodic **fleet digest** ("2 need you · 3 working · 1 idle"). Preferences persist in
the browser; the chime is synthesized with the Web Audio API (no asset, no network).
Alerts fire on the *transition* into attention (once, not every tick) and de-dupe, so
a waiting session pings you once. Delivery needs the tab open (foreground or
background); a closed tab can't receive one.

## no-mistakes

The design is inspired by [`kunchenguid/no-mistakes`](https://github.com/kunchenguid/no-mistakes)
(a git-push gate with a daemon + approval channel). This harness reuses that
shape - long-lived daemon, event stream, agent-report/approval channel - and
runs no-mistakes as a **component**.

If `no-mistakes` is installed and a session's repo is gated, the card surfaces
the live run: a `◇ gated` chip plus a strip showing the pipeline
(intent → review → test → … → ci as status dots), the gate it's parked at, and
the findings - polled via `no-mistakes axi status` (its TOON agent interface).
When a run is parked at a gate you can **approve / fix / skip** it right there;
those map to `no-mistakes axi respond --action …` (fix lets you pick findings and
add guidance). Approve and skip confirm first since they advance the pipeline
toward pushing your branch. Set `NOMISTAKES_BIN` if the binary isn't on the
daemon's PATH.

## Isolated worktrees per session (treehouse)

Running several agents in **one** working tree is a recipe for clobbering - one
agent's branch switch or edit lands under another's feet. [`kunchenguid/treehouse`](https://github.com/kunchenguid/treehouse)
solves this with a pool of pre-warmed git worktrees ("manage worktrees without
managing worktrees"): each session gets its own isolated tree, and dependencies
/ build cache aren't re-paid every time.

`make session` wires treehouse and no-mistakes together into a one-command
"start a clean session":

```sh
make session                      # lease a worktree, warm it, gate it, drop you in a subshell
make session ARGS="-- claude"     # …or launch an agent in it directly
node scripts/new-session.mjs -- claude   # equivalent, without make
```

Under the hood (`scripts/new-session.mjs`):

1. **Lease** a worktree from this repo's pool (`treehouse get --lease`), creating
   one if the pool is empty (up to `max_trees` in `treehouse.toml`).
2. **Warm + gate** it (`scripts/worktree-setup.mjs`): install dependencies so the
   session starts fast, and run `no-mistakes init` so the tree is gated.
3. **Hand it over** - open your `$SHELL` (or the command after `--`) in the tree.

The lease is durable, so a backgrounded agent keeps its tree after you exit.
Release it when done:

```sh
treehouse status                 # see the pool
treehouse return <path>          # give the worktree back to the pool
```

Because treehouse ignores lifecycle hooks in the repo-level `treehouse.toml` for
safety, the warm+gate step is run by `make session` itself. To make **every**
`treehouse get` (not just `make session`) warm and gate automatically, add a
`post_create` hook to your user config - see the comments in `treehouse.toml`.

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `HARNESS_PORT` | `7317` | daemon / dashboard port |
| `HARNESS_HOME` | `~/.ai-harness` | state dir (db, token, logs, dispatch worktrees) |
| `HARNESS_POLL_MS` | `1500` | discovery interval |
| `HARNESS_NM_POLL_MS` | `5000` | no-mistakes status interval |
| `HARNESS_DISPATCH_READY_MS` | `30000` | dispatch: how long to wait for the agent's pane to be discovered before failing |
| `HARNESS_DISPATCH_SETTLE_MS` | `2000` | dispatch: settle delay after discovery before injecting the first prompt |
| `HARNESS_CLAUDE_BIN` | `claude` | dispatched Claude CLI path override |
| `HARNESS_CODEX_BIN` | `codex` | dispatched Codex CLI path override |
| `WEZTERM_BIN` | auto | wezterm CLI path override |
| `NOMISTAKES_BIN` | auto | no-mistakes CLI path override |

## Commands

```sh
make init              # one-time bootstrap (deps, build, hooks, treehouse + no-mistakes)
make session           # start an agent in a fresh, gated worktree
npm run dev            # daemon + web (dev)
npm start              # daemon serving built UI
npm run build          # build web + MCP bundle
npm test               # unit tests (detection, correlation, hook mapping, dispatch, report)
npm run typecheck      # tsc --noEmit
npm run install-hooks  # wire Claude hooks
npm run install-service# LaunchAgent (macOS)
```

## Security

The daemon binds to loopback only, and every data endpoint (`/api/*`, `/events`)
additionally requires a loopback `Host` header so a web page you visit can't reach
it via DNS-rebinding - a defense that matters now that dispatch can launch agents
(effectively RCE) and reads leak task prompts, repo paths, and transcripts. Hook
and MCP ingress is authenticated with a per-machine token in `~/.ai-harness/token`
so other local processes can't spoof session or task state. Session and task
actions (send / focus / kill, dispatch / cancel / complete) are localhost-only.
