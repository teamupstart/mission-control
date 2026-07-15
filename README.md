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
  title**, else the repo folder. Click a card's title (or press <kbd>⇧</kbd><kbd>O</kbd>) to
  rename it - it renames the underlying tmux session / wezterm tab, which the next
  sweep reads straight back onto the card. Only a live session with a tmux or wezterm
  pane can be renamed - a session found in neither, or one that has exited, has
  nothing to rename, so its title isn't clickable.
- **Live** via Server-Sent Events - the grid updates as sessions start, work,
  go idle, need input, or exit. No polling from the browser.
- **Acts** on a session: send it a message, rename it, focus its tab, kill it, or
  reset its checkout back to origin (with a preview of exactly what that would
  discard).
- **Reviews**: an instrumented agent can push a diff, a markdown plan, or a
  question into the dashboard and block until you approve / request changes /
  answer - your decision flows straight back to the agent.
- **Dispatches** new agents: pick a repo, describe a task, and it launches an
  agent in its own isolated worktree + detached tmux session (or shelves it in a
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
it in a tab. Choose **Add to backlog** instead of **Dispatch now** to shelve a task without
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
and **recent outcomes**. Dispatch a backlog task or drop it right from the panel, and **Mark
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
- **stands in for you at a parked [no-mistakes](#no-mistakes) gate** - when a run stops to put
  an `ask-user` finding to you, Foreman reads the finding and the session's goal, answers when
  the call is clear from that goal, and escalates when it turns on your intent;
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
popover); with an empty allowlist Foreman never types into any live session. An entry
allowlists the **repo**, not just the directory: a session in a *worktree* of an
allowlisted repo is cleared too, wherever that worktree sits on disk. That's what makes
live mode usable - dispatched agents and treehouse checkouts run in worktrees parked far
from the repo, so a directory-only rule would draft forever on the very repo you cleared.
A worktree of a repo you haven't allowlisted is still refused. A separate
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

Only one worker drives the fleet at a time. `npm run foreman` twice is safe: the second
process acquires no **lease** and idles as a standby, taking over automatically if the
leader dies. That matters because two workers would double-answer a prompt - or, with work
queues below, type the same work instruction into a live agent twice.

### The cheap tier

Not every blocked session needs the expensive reviewer, so a **cheap tier** sits in front of
it and spends the big model only where judgment is actually required. **Tier 0** is pure code
and costs nothing: a plan/diff review is always yours to approve, so it's disposed with a
Purpose and no model call at all. **Tier 1** is a cheap router (Haiku) that reads a trimmed
transcript and *buckets* the ask rather than solving it. Only the genuine judgment calls route
up to the full **Tier 2** review, which is unchanged.

The tier is **asymmetric on purpose**. It may hand a session back to you (skip) or ask you
(escalate) freely, but it may auto-answer only one tightly bounded category - routine,
non-destructive access - and that answer flows through the *same* mode + allowlist +
auto-approve gate the full reviewer's answers do, so it can never send under a looser config
than Opus would. Four code backstops the router cannot override sit behind it: the destructive
denylist above forces an escalation, low confidence routes up, a window with nothing to scan
counts as *unknown* rather than safe and routes up, and a parked no-mistakes gate is never the
cheap tier's to answer - it may only escalate (cheap, and puts the gate in front of you) or
route up to the reviewer that was taught to judge one.

Pick the posture with the **Cheap tier** control in the popover:

| Cheap tier | What it does |
|------|--------------|
| **shadow** (default) | runs the cheap tier *alongside* the full review, acts on the **full review**, and logs every divergence - so its accuracy is measured before you trust it |
| **on** | the cheap tier disposes the easy cases; the full review fires only on route-up |
| **off** | every new prompt gets a full review (the pre-tier behavior) |

The worker log is the audit surface for the rollout: every acted session logs the tier that
decided it (`[tier 2] answer/access -> answered (sent)`), and shadow mode adds a divergence line
per session (`shadow cheap-over-eager (cheap=… opus=…)`). `cheap-over-eager` - the cheap tier
would have answered where Opus would not - is the one to watch before flipping to **on**.

## Work queues (load a session up and walk away)

Foreman above is *reactive* - it answers what a blocked session is asking. A **work queue**
is the proactive half: queue a batch of work for one specific session, and Foreman feeds it
in one item at a time, in the order you authored, checking each one before releasing the
next.

Open a card and use the **Work queue** panel: type an intent, **Add**, repeat. Items are
drag-reorderable, editable, and removable while they wait. Then walk away. For each item
Foreman:

1. waits for the session to actually go **idle and settle** (not just look idle);
2. **delivers** the intent as a single bracketed paste (so a multi-line prompt doesn't
   submit halfway through);
3. waits for the agent to finish, then **verifies** the work in a fresh tool-less
   `claude -p` - reading the item's own diff and transcript against the repo's `AGENTS.md`
   / `CLAUDE.md`;
4. if something's genuinely missing, hands the **specific gaps** back to the agent to fix
   and re-checks - escalating to you only once an issue looks beyond it;
5. releases the next item.

When the queue drains it asks whether to open a PR and run no-mistakes. It always **asks**;
it never launches those itself.

**Verification is evidence-only by design.** It reads the diff and the transcript - it does
not run tests. `/no-mistakes` remains the gate that actually executes things; Foreman's job
here is the narrower question no pipeline answers: *was the thing you asked for actually
done?* Gaps carry a severity, and only **blocking** ones send the agent back - a style nit
lands as advisory, shows on the card, and never costs a round. Two knobs in the Foreman
popover bound it: **fix attempts per issue** (default 3) and **max fix rounds per item**
(default 10, the hard stop).

Sends obey the same gate as everything else: dry-run **drafts** each item and waits for your
**Approve**, and live sends only happen in allowlisted repos. Verification is read-only, so
it runs in any mode - you see Foreman's judgment before it ever types. A queue needs a
hook-instrumented Claude session (there's no completion signal otherwise), and the panel
says so rather than letting you queue work that can't run.

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
| <kbd>⇧</kbd><kbd>O</kbd> | Rename the selected session (its tmux session / wezterm tab) | Selected session |
| <kbd>k</kbd> | Kill the selected session | Selected session |
| <kbd>⌃</kbd><kbd>R</kbd> | Reset the selected session's checkout to origin and clear its context (confirms first) | Selected session |

Every shortcut except the arrow keys and <kbd>Esc</kbd> is **customizable**. Open
**Settings** - the ⚙ gear in the top bar, or (in the desktop app) **Agent Wrangler →
Settings…** / <kbd>⌘</kbd><kbd>,</kbd> - then click a shortcut and press the new key
(optionally with <kbd>⌘</kbd> / <kbd>⌃</kbd> / <kbd>⌥</kbd> / <kbd>⇧</kbd>). On a letter,
<kbd>⇧</kbd> counts as a modifier - <kbd>⇧</kbd><kbd>O</kbd> is a binding in its own right and
plain <kbd>o</kbd> does *not* trigger it. On a key that already shifts into another character
(<kbd>+</kbd>, <kbd>?</kbd>), just press that character. Bindings persist per machine,
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
toward pushing your branch. [Foreman](#foreman-auto-responder), if enabled, can take
the first look at a parked gate for you: it reads the finding the run relayed and
either answers it or escalates it as a decision brief, rather than leaving the run
parked until you get to it.

Resetting a checkout (the card's **reset** control, <kbd>⌃</kbd><kbd>R</kbd>) also
**retires the run the card was showing**, clearing the strip and its narration for
good. The reset throws away the very work that run validated, but `axi status` keeps
reporting it for the branch long after - a reset moves the branch *pointer*, not the
branch *name* - so simply clearing the strip wouldn't hold: the next poll would put
it straight back. The dismissal is remembered per run, so a **new** run on the same
branch decorates the card again, and it's scoped to the checkout that was wiped
(worktree root + branch): a session sharing that worktree clears too, while a session
on the same branch in a *different* worktree keeps its strip, its work still being on
disk. A reset that fails leaves the strip alone.

Set `NOMISTAKES_BIN` if the binary isn't on the daemon's PATH.

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
make session ARGS="--holder mine" # …under your own lease label (see below)
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

### Leaked leases are reclaimed for you

A durable lease is what lets a backgrounded agent survive a restart, but it also
means nothing frees a tree when its agent simply goes away. Left alone those
leases pile up until the pool hits `max_trees` with **zero available**, and every
later `treehouse get` fails - at which point a dispatch falls back to a throwaway
`git worktree` and the pool stops being reused at all. (`treehouse prune` can't
help: it skips any tree with an owner reservation, and a leaked lease is one.)

So the daemon sweeps every treehouse repo it can name - the ones behind your live
sessions and tracked tasks, plus every checkout under `FLEET_WORKSPACE_DIRS` -
each `FLEET_POOL_REAP_MS`, and again whenever a dispatch finds the pool dry. The
workspace scan is what reaches a *fully* leaked repo: once its agents are gone
there is no live session left to advertise it, and you can't start one to fix
that, because `treehouse get` is precisely what fails when the pool is dry.

It hands back only the leases it can prove are dead, and only its **own**. A tree
is returned **only** when it is leased to `fleet-control` (the holder both `make
session` and dispatch record), treehouse reports no processes under it, no live
session's cwd is inside it, no task the harness tracks still records it, it has no
uncommitted changes, and origin's default branch already contains its HEAD.
Anything else - including any uncertainty - leaves the lease alone: a leaked lease
costs a slot, a wrong reap costs your work.

The holder check is the harness's own rule, not something treehouse enforces
(`treehouse return` takes a path and checks no holder). It matters because a lease
survives *"even with no process running inside it, until you release it"* - so a
tree you reserved with `treehouse get --lease --lease-holder my-label` is idle **on
purpose**, and the sweep leaves it exactly where you put it, in this repo or any
other one it walks. Reclaiming a `fleet-control` lease is only fair game because
this harness took it and can tell its holder is gone.

That is also the escape hatch from this side: `make session ARGS="--holder my-label"`
(or `node scripts/new-session.mjs --holder my-label`) still warms and gates the tree
the usual way, but records the lease under **your** label instead, so the sweep will
never collect it - park a tree that way and it is yours until you
`treehouse return` it yourself.

The flip side is that the sweep only knows the label it records *today*. A lease
`make session` took under this project's old `ai-harness` name is skipped like any
other holder's, since nothing tells it apart from a reservation someone made under
that label on purpose. If `treehouse status` shows an old idle lease the sweep
never collects, hand it back yourself: `treehouse return <path>`.

Note that a *live* agent's tree is often clean and merged (right after a push), so
it's the liveness checks, not the git ones, that keep it yours - and a task's tree
stays its own even after the agent exits, which is what lets **Mark done** keep
your work. Because those liveness checks are the load-bearing ones, they're
re-taken immediately before a tree is handed back, so a tree leased while the
sweep was fetching is never returned on the strength of a reading from before it
existed.

Set `FLEET_POOL_REAP_MS=0` to switch the background sweep off entirely; the
dispatch-time reap stays on, since its only alternative is abandoning the pool
for a throwaway worktree.

That last-resort fallback is no longer silent, which is how a pool could sit full
without anyone noticing: a dispatch that still can't get a tree warns in the daemon
log and points you at `treehouse status`. It reports what it actually observed and
quotes treehouse's own words rather than blaming a full pool - `get` fails the same
way for an unresolvable pool or a bad config, and sending you to a `treehouse status`
that looks perfectly healthy would help nobody.

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `FLEET_PORT` | `7317` | daemon / dashboard port |
| `FLEET_HOME` | `~/.fleet-control` | state dir (db, token, logs, dispatch worktrees) |
| `FLEET_WORKSPACE_DIRS` | `~/workspace` | colon-separated roots scanned for the dispatch repo picker, and for the treehouse pools the leaked-lease sweep visits |
| `FLEET_POLL_MS` | `1500` | discovery interval |
| `FLEET_NM_POLL_MS` | `5000` | no-mistakes status interval |
| `FLEET_POOL_REAP_MS` | `300000` | how often to sweep treehouse pools for leaked leases. `0` (or any non-positive value) turns the background sweep off; an unparseable value falls back to the default; anything under `30000` is clamped up to it, and anything over `604800000` (7d) clamped down to it, since past ~24.8d `setTimeout` overflows into a hot loop |
| `FLEET_DISPATCH_READY_MS` | `30000` | dispatch: how long to wait for the agent's pane to be discovered before failing |
| `FLEET_DISPATCH_SETTLE_MS` | `2000` | dispatch: settle delay after discovery before injecting the first prompt |
| `FLEET_CLAUDE_BIN` | `claude` | dispatched Claude CLI path override |
| `FLEET_CODEX_BIN` | `codex` | dispatched Codex CLI path override |
| `WEZTERM_BIN` | auto | wezterm CLI path override |
| `NOMISTAKES_BIN` | auto | no-mistakes CLI path override |
| `FOREMAN_CLAUDE_BIN` | `claude` | Foreman reviewer: Claude CLI path override |
| `FOREMAN_REVIEW_TIMEOUT_MS` | `120000` | Foreman: hard cap on one session review before it's abandoned |
| `FOREMAN_EVAL_DEBOUNCE_MS` | `60000` | Foreman: minimum wall-clock gap between evaluations of the same session |
| `FOREMAN_TRIAGE_MODEL` | `claude-haiku-4-5` | Foreman [cheap tier](#the-cheap-tier): Tier 1 router model (the `triageModel` config wins over this) |
| `FOREMAN_TRIAGE_TIMEOUT_MS` | `30000` | Foreman cheap tier: hard cap on the Tier 1 router; a timeout just routes up to the full review |

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
actions (send / rename / focus / kill, dispatch / cancel / complete) are localhost-only.
