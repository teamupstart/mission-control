# Fleet Control

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
- **Rounds up** the whole fleet: who needs you, who's working, what's idle,
  the backlog, and recent outcomes - as a panel, JSON, or markdown digest.
- **Alerts** you when the fleet needs you: a desktop notification + sound the
  moment a session needs input, a review lands, a no-mistakes gate parks, or a
  dispatched task fails - with an **AFK mode** that also pings on idle sessions and
  finished tasks and sends periodic fleet digests.
- **Triages** the needs-you queue for you: **Foreman** is an optional auto-responder
  that reads each blocked session's transcript, auto-answers the routine calls,
  escalates the genuine forks as a decision brief, and writes a one-line Purpose on
  every card - shipping OFF and drafting its answers before it ever sends.

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

## Desktop app (macOS)

Prefer a real menu-bar app over a browser tab? Agent Wrangler packages into a native
macOS app (Apple Silicon) that supervises the daemon, shows the dashboard in a window,
and - crucially - **delivers alerts even with the window closed** (a browser tab can't).

```sh
make app            # build + package → release/Agent Wrangler-<version>-arm64.dmg
make install-app    # …and copy Agent Wrangler.app into /Applications
```

The app is self-contained: the daemon runs on Electron's bundled Node (with `node:sqlite`),
so no system `node` is required to run it. On launch it **adopts** an already-running daemon
(a LaunchAgent or `make up`) instead of starting a second one. Closing the window hides it
(the app stays in the menu bar so alerts keep firing); quit from the tray menu. Enable
**Start at login** and **Install Claude integrations…** (wires the status hooks + MCP review
server at the app's bundled paths) from the tray menu.

Because it's a local, unsigned build, the first launch may need a right-click → **Open**
(or `xattr -dr com.apple.quarantine "/Applications/Agent Wrangler.app"`).

For desktop development with the same hot-reload loop as the browser:

```sh
make desktop        # daemon (tsx watch) + Vite (HMR) + Electron shell, all auto-reload
make start          # same, plus the Foreman auto-responder worker
make restart        # stop any running stack and start it fresh
```

The window loads the Vite dev server, so React Fast Refresh works inside it exactly as in
the browser; the Electron shell restarts on main-process edits. `make start` adds the
[Foreman](#foreman-auto-responder) worker to the group so it comes up with the app (it
otherwise only runs via `npm run foreman`); `make restart` tears the whole stack down and
brings it back up. The plain `make dev` browser workflow is unchanged. See [docs/plans/migrate-electron.md](docs/plans/migrate-electron.md)
for the full design.

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
Wired Fleet Control hooks into /Users/you/.claude/settings.json
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
`http://127.0.0.1:7317/hooks/<event>` with the `~/.fleet-control/token`. The daemon
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

A Claude card also carries a **permission mode** chip once a hook reports one - `manual`,
`accept edits`, or `plan` on the standard cycle, plus `bypass` / `auto` / `don't ask` for
sessions that enable them. <kbd>⇧</kbd><kbd>Tab</kbd> cycles it, exactly as the keystroke
would in the session's own terminal.

### Review channel (MCP)

```sh
npm run build                    # builds the MCP server bundle
claude mcp add -s user fleet-control -- node /ABSOLUTE/PATH/dist/mcp/server.mjs
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

## Dispatch an agent

The dashboard isn't just a mirror - you can launch new agents from it. Click **＋
Dispatch** (or press <kbd>+</kbd>), pick a repo, describe the task, and the daemon:

1. provisions an **isolated worktree** for the task (a pooled
   [treehouse](#isolated-worktrees-per-session-treehouse) tree when the repo opted in,
   else a plain `git worktree` on a fresh `harness/…` branch - so an agent never shares
   a working tree with another session),
2. launches the agent (`claude`/`codex`) in a **detached tmux session** rooted there -
   with a second **shell pane split beside it** in the same worktree, so a terminal for
   ad-hoc git/build/inspection is one attach away, and
3. injects your task as its first prompt once passive discovery binds the session.

The repo picker is a **searchable index of your workspace** - the daemon scans
`~/workspace` (override with `FLEET_WORKSPACE_DIRS`) for git checkouts, so you select the
repo to base the task on rather than typing a path. Type to filter; arrow/enter to pick.

The new session then shows up on the grid like any other, with an **intent chip** naming
what it's working on. It's headless until you want it - click **Focus** on the card to open
it in a tab. Choose **Add to backlog** instead of **Dispatch now** to queue a task without
launching it yet.

Closing the dispatch form (<kbd>Esc</kbd>, a backdrop click, **Cancel**, or the ✕) **keeps
what you've typed** - reopen and a half-written task is still there, so you can glance at
the grid mid-thought without losing it. The draft is cleared only once the task is actually
dispatched or queued, or when you hit **Clear** to start a fresh one. A submit that fails
leaves the form open with your fields intact so you can retry.

Every dispatched task is a durable record (repo, intent, kind, worktree, branch, outcome)
persisted in SQLite, so the backlog and a running agent's intent survive a daemon restart.
Set `FLEET_CLAUDE_BIN` / `FLEET_CODEX_BIN` if the agent CLI isn't on the daemon's PATH.

## Roundup

Click **Roundup** for a one-look snapshot of the whole fleet, assembled from the same live
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

## Foreman (auto-responder)

The dashboard tells you *who needs you*; **Foreman** can start draining that queue for
you. It's an optional agent that watches the `needs-you` bucket and, for each blocked
Claude session, reads the transcript to understand the goal, then:

- **auto-answers** the routine calls - implementation trade-offs (defaulting to the most
  correct, secure, non-duplicative option) and non-destructive access requests;
- **escalates** the genuine forks - a call that hinges on your intent, or anything
  destructive/risky - as a framed **decision brief** with its recommendation, and pings you;
- writes a 1-2 sentence **Purpose** on every session it inspects, shown in the expanded
  card so you can re-orient at a glance.

Each session is reviewed in a **fresh `claude -p` process**, so context never bleeds
between reviews. Foreman ships **OFF**, and even once enabled it starts in **dry-run**: it
only *drafts* answers onto the card until you trust it. Start the worker - a plain agent in
a terminal that talks to the daemon over localhost - with:

```sh
npm run foreman
```

Control it from the **Foreman** control in the top bar (beside Alerts): enable it, then
pick a mode.

| Mode | What it does |
|------|--------------|
| **dry-run** (default) | drafts a reply onto the card; never sends |
| **semi-auto** | drafts a reply with a one-click **Approve & send** on the card |
| **live** | sends the reply on your behalf - but only in repos you've **allowlisted** |

Live sending is gated by an explicit **repo allowlist** (paths, one per line in the
popover); with an empty allowlist Foreman never types into any live session. A separate
**Auto-approve non-destructive access** switch (on by default) governs whether it may
approve access/permission asks - turn it off and those escalate to you instead.
Destructive or risky asks (force-push, secret access, prod deploy, data drops, disabling a
safety check) are **always** escalated, never auto-approved.

Everything Foreman does surfaces on the card: a needs-you session it acted on shows a
**◆ decision** flag (or **✎ draft**) in its header, the expanded card shows the decision
brief + recommended answer with **Approve & send / Dismiss** controls, and an answered
session carries a `✓ Foreman answered: …` audit line. An escalation also fires a browser
**alert**. The top-bar chip shows the mode, whether the worker is running, and the queue
depth.

## Keyboard shortcuts

The dashboard is keyboard-driven - select a card with the arrow keys and act on it
without reaching for the mouse:

| Key | Action | Scope |
|-----|--------|-------|
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Move the selection around the grid | Anywhere |
| <kbd>Esc</kbd> | Peel back a layer - collapse an expanded card, then deselect | Anywhere |
| <kbd>r</kbd> | Toggle the Roundup panel | Anywhere |
| <kbd>+</kbd> | Dispatch an agent | Anywhere |
| <kbd>/</kbd> | Focus the filter box | Anywhere |
| <kbd>e</kbd> | Expand / collapse the selected card | Selected session |
| <kbd>d</kbd> | Open the selected session's diff | Selected session |
| <kbd>s</kbd> | Send a message to the selected session | Selected session |
| <kbd>f</kbd> | Focus the selected session's pane | Selected session |
| <kbd>⇧</kbd><kbd>Tab</kbd> | Cycle the permission mode (Claude only) | Selected session |
| <kbd>k</kbd> | Kill the selected session | Selected session |

Every shortcut except the arrow keys and <kbd>Esc</kbd> is **customizable**. Open
**Settings** - the ⚙ gear in the top bar, or (in the desktop app) **Agent Wrangler →
Settings…** / <kbd>⌘</kbd><kbd>,</kbd> - then click a shortcut and press the new key
(optionally with <kbd>⌘</kbd> / <kbd>⌃</kbd> / <kbd>⌥</kbd>). Bindings persist per machine,
duplicate assignments are flagged inline, and you can reset any one shortcut (or all of
them) to its default. The arrow keys and <kbd>Esc</kbd> drive grid navigation and can't be
reassigned.

## no-mistakes

The design is inspired by [`kunchenguid/no-mistakes`](https://github.com/kunchenguid/no-mistakes)
(a git-push gate with a daemon + approval channel). This harness reuses that
shape - long-lived daemon, event stream, agent-report/approval channel - and
runs no-mistakes as a **component**.

If `no-mistakes` is installed and a session's repo is gated, the card surfaces
the live run: a `◇ gated` chip plus a strip showing the pipeline
(intent → review → test → … → ci as status dots), the active stage it's on
(e.g. `review · step 3 of 9 · 1 finding so far`), a running findings summary in
the header, the gate it's parked at, and the findings - all polled via
`no-mistakes axi status` (its TOON agent interface). A separate live narration
line echoes what the skill is doing right now, read from the in-progress to-do in
the session's Claude transcript. The active-stage, summary, and narration lines
step aside while a run is parked, where the gate line already conveys that state.
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
| `FLEET_PORT` | `7317` | daemon / dashboard port |
| `FLEET_HOME` | `~/.fleet-control` | state dir (db, token, logs, dispatch worktrees) |
| `FLEET_WORKSPACE_DIRS` | `~/workspace` | colon-separated roots scanned for the dispatch repo picker |
| `FLEET_POLL_MS` | `1500` | discovery interval |
| `FLEET_NM_POLL_MS` | `5000` | no-mistakes status interval |
| `FLEET_DISPATCH_READY_MS` | `30000` | dispatch: how long to wait for the agent's pane to be discovered before failing |
| `FLEET_DISPATCH_SETTLE_MS` | `2000` | dispatch: settle delay after discovery before injecting the first prompt |
| `FLEET_CLAUDE_BIN` | `claude` | dispatched Claude CLI path override |
| `FLEET_CODEX_BIN` | `codex` | dispatched Codex CLI path override |
| `WEZTERM_BIN` | auto | wezterm CLI path override |
| `NOMISTAKES_BIN` | auto | no-mistakes CLI path override |
| `FOREMAN_CLAUDE_BIN` | `claude` | Foreman reviewer: Claude CLI path override |
| `FOREMAN_REVIEW_TIMEOUT_MS` | `120000` | Foreman: hard cap on one session review before it's abandoned |

> **Upgrading from `HARNESS_*`?** The old `HARNESS_*` env names are still honored as
> a fallback, and an existing `~/.ai-harness` state dir is kept in place (the new
> `~/.fleet-control` default only applies to fresh installs), so nothing breaks on
> an in-place update. Prefer the `FLEET_*` names going forward.

## Commands

```sh
make init              # one-time bootstrap (deps, build, hooks, treehouse + no-mistakes)
make session           # start an agent in a fresh, gated worktree
npm run dev            # daemon + web (dev)
npm start              # daemon serving built UI
npm run foreman        # Foreman auto-responder worker (drains the needs-you queue)
npm run build          # build web + MCP bundle
npm test               # unit tests (detection, correlation, hook mapping, dispatch, report, alerts, foreman)
npm run typecheck      # tsc --noEmit
npm run install-hooks  # wire Claude hooks
npm run install-service# LaunchAgent (macOS)
```

## Security

The daemon binds to loopback only, and every data endpoint (`/api/*`, `/events`)
additionally requires a loopback `Host` header so a web page you visit can't reach
it via DNS-rebinding - a defense that matters now that dispatch can launch agents
(effectively RCE) and reads leak task prompts, repo paths, and transcripts. Hook
and MCP ingress is authenticated with a per-machine token in `~/.fleet-control/token`
so other local processes can't spoof session or task state. Session and task
actions (send / focus / kill, dispatch / cancel / complete) are localhost-only.
