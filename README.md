# Mission Control

A local, auto-refreshing dashboard for Claude Code / Codex / Pi sessions running
across your **terminal panes** or embedded through an **Agent SDK**. See every agent at a glance,
act on any of them, and let an agent push a **diff or plan** to you for review -
and get your decision back.

<!-- screenshot: docs/dashboard.png -->

## What it does

- **Discovers** every terminal-backed `claude` / `codex` / `pi` session by walking process →
  controlling TTY → terminal pane, and registers the embedded sessions it dispatches.
  No per-session setup is required for terminal discovery.
- **Names** each session from its **innermost terminal pane**, else the repo folder. Click a
  card's title (or press <kbd>⇧</kbd><kbd>O</kbd>) to rename it - it renames the underlying
  terminal home, which the next sweep reads straight back onto the card. Only a live session
  with a terminal pane can be renamed - a session found in no backend at all, or one that
  has exited, has nothing to rename, so its title isn't clickable. A Ghostty tab is named
  and still cannot be renamed, for a different reason: its titles are read-only, so that
  backend declares no retitle at all. See
  [Which terminal you use is declared](#which-terminal-you-use-is-declared-not-assumed).
- **Live** via Server-Sent Events - the grid updates as sessions start, work,
  go idle, need input, or exit. No polling from the browser.
- **Acts** on a session: send it a message, rename it, focus its tab, kill it, or
  reset its checkout back to origin (with a preview of exactly what that would
  discard). A reset also **releases the branch** the checkout was standing on,
  landing it on origin's default commit with no branch checked out - so a reused
  session starts its next task free of the finished one's branch, rather than
  carrying its PR chip and taking the next commits onto a branch already merged.
  A checkout already on the default branch is left on it.
- **Reviews**: an instrumented agent can push a diff, a markdown plan, or a
  question into the dashboard and block until you approve / request changes /
  answer - your decision flows straight back to the agent.
- **Answers the menus** a session is parked on - a permission prompt, an
  `AskUserQuestion` clarification, a folder-trust check - as
  [clickable options on the card](#answer-a-sessions-menu-from-the-dashboard).
  Terminal sessions are read straight off their pane, so that path works with or without
  hooks; Agent SDK sessions deliver the same asks as structured data.
- **Dispatches** new agents: pick a repo, describe a task, and it launches an
  agent in its own isolated worktree, using that harness's configured
  [session runtime](#session-runtimes-terminal-or-the-agent-sdk), or shelves it in a
  backlog for later, where clicking it [reopens the form](#edit-a-shelved-task) to
  edit or send, and a switch on the row [holds it back](#hold-a-backlog-item-back)
  from the autopilot without taking it off the list).
- **Pulls work in** from systems that already hold it: a [task source](#task-sources-pulling-work-into-the-backlog)
  sweeps GitHub issues on a schedule and files them into the backlog, so the work you
  already wrote down somewhere doesn't have to be re-typed. It files backlog rows and
  nothing else - it never dispatches an agent and never types into a session. Ships with
  no sources configured.
- **Rounds up** every session: who needs you, who's working, what's idle,
  the backlog, and recent outcomes - as a panel, JSON, or markdown digest.
- **Alerts** you when a session needs you: a desktop notification + sound the
  moment a session needs input, a review lands, a no-mistakes gate parks, a session
  **gets stuck**, or a dispatched task fails - with an **Away mode** that buffers the
  rest and hands you one digest when you come back.
- **Tracks fleet economics**: a badge on every priced card and a topbar strip carrying
  one Claude + Codex API-equivalent estimate, tokens, estimated cost per pull request,
  and rate-limit runway. Claude calculates its rows and reports them over OpenTelemetry;
  Mission Control calculates Codex rows from request-level rollout counters. See
  [Cost telemetry](#cost-telemetry).
- **Says what each prompt-reporting session is for**: its card carries a one-sentence
  **Goal** - what that session is currently trying to solve - derived from your own
  prompts and refreshed as you steer it. No API key: it runs the configured local
  model provider.
- **Triages** the needs-you queue for you: **Foreman** is an optional auto-responder
  that reads each blocked session's transcript, auto-answers the routine calls, and
  escalates the genuine forks as a decision brief - shipping OFF and drafting its
  answers before it ever sends.
- **Builds reusable review workflows**: open **Workflows** in the top bar to author exact
  Markdown Personas, then arrange Session, Persona, all-pass Join, Check, and End nodes on a
  validated canvas. Drafts autosave with conflict protection and Publish captures immutable
  Persona snapshots. Bind a published version to a session and start a manual **Preview** to
  run concurrent, read-only Persona reviews against one immutable evidence snapshot. A
  published Inspector final gate can then require the exact clean PR head to pass before the
  workflow completes.
- **Equips** every session with [skills](#skills-every-session-mixed-reload-behavior): switch
  a skill on in Settings and it is linked into each harness's own skills directory, including
  sessions this app never launched. Claude reloads when idle, Codex watches automatically,
  dispatched identity-bound Pi sessions reload when idle, and operator-started Pi sessions
  pick changes up on their next launch or restart.
- **Lands the clean ones**, if you let it: [YOLO mode](#shipping-yolo-mode) merges a pull
  request Mission Control opened once the Inspector has reviewed and **published** on the
  current push with nothing outstanding, CI is green, no thread is unresolved, and it has
  been open for a soak window you set. Needs the Inspector on **and** live; dry run merges
  nothing. Ships off, trusting no repositories.

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

Prefer a real menu-bar app over a browser tab? Mission Control packages into a native
macOS app (Apple Silicon) that supervises the daemon, shows the dashboard in a window,
and - crucially - **delivers alerts even with the window closed** (a browser tab can't).

```sh
make app            # build + package → release/Mission Control-<version>-arm64.dmg
make install-app    # …and copy Mission Control.app into /Applications
```

The app is self-contained: the daemon runs on Electron's bundled Node (with `node:sqlite`),
so no system `node` is required to run it. On launch it **adopts** an already-running daemon
(a LaunchAgent or `make up`) instead of starting a second one. Closing the window hides it
(the app stays in the menu bar so alerts keep firing); quit from the tray menu. Enable
**Start at login** and **Install Claude integrations…** (wires the status hooks + MCP review
server at the app's bundled paths) from the tray menu.

Because it's a local, unsigned build, the first launch may need a right-click → **Open**
(or `xattr -dr com.apple.quarantine "/Applications/Mission Control.app"`).

For desktop development with the same hot-reload loop as the browser:

```sh
make desktop        # daemon (tsx watch) + Vite (HMR) + Electron shell, all auto-reload
make start          # same, plus the Foreman auto-responder worker
make restart        # stop any running stack and start it fresh
```

The window loads the Vite dev server, so React Fast Refresh works inside it exactly as in
the browser; the Electron shell restarts on main-process edits. In this mode `dev:server`
alone owns the daemon and its restart loop; Electron only supervises the daemon in the
packaged app. `make start` adds the [Foreman](#foreman-auto-responder) worker to the group
so it comes up with the app (it otherwise only runs via `npm run foreman`); `make restart`
tears the whole stack down and brings it back up. The plain `make dev` browser workflow is
unchanged. See [docs/plans/migrate-electron.md](docs/plans/migrate-electron.md) for the full
design.

## How it works

Three layers, most-to-least automatic:

| Layer | Setup | Gives you |
|-------|-------|-----------|
| **Passive discovery** | none | inventory + names + branch + uptime, live - plus any [option menu](#answer-a-sessions-menu-from-the-dashboard) a session is parked on |
| **Claude hooks** | `npm run install-hooks` | precise state (working / idle / needs-input) + activity |
| **MCP review channel** | `claude mcp add …` (see below) | agents push diffs / plans / questions for you to decide |

One long-lived **daemon** (`src/server`) serves the React SPA (`src/web`) plus a
JSON API and an SSE stream on `127.0.0.1:7317`. A ~1.5s poller sweeps `ps` plus
every terminal backend it knows about (today `tmux list-panes`, `cmux tree`,
`wezterm cli list`, and Ghostty through AppleScript) and reconciles an in-memory registry
that broadcasts changes over SSE. Reviews and dispatched tasks are persisted in SQLite
(`node:sqlite`).

That same sweep re-reads the mutable Git facts in each session's checkout: its branch and
whether the repo is gated by no-mistakes. Sessions the daemon runs itself (Agent SDK
`runtime`) have no process on a tty for the sweep to find, so those facts are read directly
from their working directory at launch or restoration and refreshed on the same cadence.
This keeps both the **PR chip** and [no-mistakes](#no-mistakes) status honest without a
terminal session sharing the checkout. A pooled worktree is often leased with no branch at
all, and the PR poller finds a session's pull request by asking
`gh pr list --head <branch>`; similarly, the no-mistakes status poller visits only gated
checkouts. Capturing either fact only once would leave live changes invisible.

### The title bar stays compact at half-screen

The **fleet pulse** is one readout, not a row of pills: the connection state leads it
(`live`, or `reconnecting`, which dims the figures beside it because they are then stale),
followed by the session counts and the **to answer** count, which is clickable and opens the
[attention inbox](#attention-inbox-one-place-to-drain-what-needs-you). It sits beside `need
you` and means something narrower: `need you` counts SESSIONS in an attention state, while `to
answer` counts the things you can actually settle - and it is the figure that has to match what
the click opens.

When the desktop window narrows, the bar progressively collapses secondary labels instead
of adding ragged rows. The filter becomes its **⌕** glyph; click it or press <kbd>/</kbd> to
reopen it, and it stays open while a filter is active. **Dispatch keeps its label at every
supported desktop width.** Collapsed controls keep their tooltips and accessible names.

The result stays on one row down to roughly half of a desktop screen. Narrower windows may
fall back to wrapping; phone layouts are not a supported target.

### Which terminal you use is declared, not assumed

Discovery names no terminal. It asks each registered backend what panes it can see and
joins them to agent processes by controlling tty, so a session is named by the
**innermost** backend holding its pane: a multiplexer session name (tmux, cmux) if there
is one, else a terminal tab title (WezTerm, Ghostty), else `<agent> <pid>`. A session can
hold a handle from each - a tmux pane lives *inside* a WezTerm pane - and both are kept,
because writes go to the innermost while raising a window is the outer one's job.

**Supported today**: tmux and [cmux](https://cmux.com) on the multiplexer axis, WezTerm and
Ghostty on the emulator axis. cmux needs one setting before the daemon can see it - it ships
refusing socket connections from processes it did not start itself, so set
`"automation": { "socketControlMode": "allowAll" }` in `~/.config/cmux/cmux.json` and
restart cmux. Without it your cmux sessions still appear, named `<agent> <pid>` like any
other unrecognised terminal.

The two axes are separate for that reason. A **multiplexer** has named sessions that
outlive any window and a copy-mode that can swallow keystrokes; a **terminal emulator**
raises windows and has no persistence. Neither is a subset of the other, and a backend
declares what it genuinely cannot do rather than stubbing it.

A session therefore carries a **list** of the panes it is reachable through, one per
backend, rather than a field per vendor - so a backend the dashboard has never heard of
is drawn, typed into and torn down like any other. Pane mechanics such as Rename ask one
predicate over that list instead of naming particular terminals. Delivery features such as
the Send box, mode picker, work queue and Foreman ask the runtime-aware predicate described
below; for today's terminal sessions the two answers are identical.

The same declaration decides how a session is **typed into and read**. A reply, a queued
prompt, a menu keystroke, a <kbd>⇧</kbd><kbd>Tab</kbd> and a pane read are all handed to
the backend holding the innermost pane, which renders them in its own convention - tmux
takes key names, WezTerm takes escape sequences - so nothing above that layer knows which
terminal it is talking to. Everything you send through tmux or WezTerm arrives as
written, including a message that begins with a dash. Those backends pipe payload text on
stdin, so prompts carrying a whole plan or phase document are not constrained by a
command-line size limit. The cmux and Ghostty adapters still carry text in command-line
arguments and can refuse a payload that reaches the operating system's argument limit;
that refusal is reported without claiming that any text reached the pane. A backend that
cannot be typed into at all refuses and names itself, rather than reporting that the
session has no terminal.

The same declaration decides a session's **lifecycle** - Focus, Rename, Kill, and where a
dispatched agent is launched in the first place. Focus is the clearest case, because it is
genuinely two steps on two axes: the multiplexer selects the pane, which decides what the
session *shows* and raises nothing, and then an emulator puts a window in front of you -
the tab already running a client for that session, else its own tab, else a fresh one
opened on the multiplexer's own attach command. A machine with a multiplexer and no
scriptable terminal still lands the first half and says plainly that it could not do the
second.

Rename and Kill split the same way. Renaming a multiplexer-hosted session moves the
session name *and* retitles every tab attached to it; renaming an emulator-hosted one sets
a tab title. Kill always signals the agent, and additionally tears down the whole group
when the backend says it has one - a multiplexer session is a group, a terminal tab is
not, and that is declared rather than inferred from which vendor answered. If a Mission
Control task was running in that session, killing it also settles the task - see
[when a task's agent goes away](#when-a-tasks-agent-goes-away).

**Dispatch follows whichever backend you actually have.** With a multiplexer installed you
get what you always got: a detached session with a shell pane split beside the agent. With
none, the agent is launched into a terminal tab rooted at the same worktree, so a machine
without tmux can still dispatch instead of failing with a bare `ENOENT`. What a name may
be follows the backend too - the characters tmux cannot hold in a target spec are tmux's
rule, applied when a name is cut from a task title and when you type one into Rename, from
one declaration rather than two half-copies.

You pay nothing for backends you do not use: a terminal whose binary is not installed is
skipped from the filesystem, without a process being spawned for it on any tick.

Each backend also declares which inherited environment variables to drop before its CLI
runs. WezTerm drops `WEZTERM_UNIX_SOCKET`: a daemon started from a WezTerm pane inherits a
socket pinned to that GUI, and when the GUI restarts the socket goes stale and every tab
would otherwise fall back to a `claude <pid>` name that Focus cannot raise. cmux drops
`CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` / `CMUX_TAB_ID`, which are not a socket pin but a
default *target*: a daemon started inside a cmux terminal would aim anything untargeted at
that one workspace. tmux declares nothing to drop - its `TMUX` names a server that is alive
by definition, and it is the same server the app types into.

A backend can also declare that it cannot be trusted about something, which is not the same
as lacking it. cmux 0.64.20 mis-reports the controlling tty of a workspace holding more than
one terminal split - it hands the newer split's tty to the older surface - and the tty is
the only thing joining a process to a pane. Rather than pass that on and bind a card to a
pane its agent is not in, the adapter reports no tty for those workspaces: the session still
appears, named `<agent> <pid>`. For the same reason a session **dispatched** into cmux gets
no companion shell pane, since opening one is what would trigger it.

**Ghostty**, on macOS, is one of those backends. It has no CLI worth the name -
`ghostty +new-window` answers "not supported on this platform" - so it is driven through
its AppleScript dictionary, which lists windows, tabs and surfaces. The first time the
daemon asks it anything, macOS raises an Automation prompt ("Mission Control wants to
control Ghostty"); allow it once. **Deny it and enumeration returns nothing, silently.**
Your terminal keeps working and its sessions fall back to `claude <pid>` names, so a
Ghostty tab that never gets named is the symptom to take to *System Settings → Privacy &
Security → Automation*. Nothing is asked of Ghostty at all while it is not running -
asking would launch it, and a terminal window opening on your desktop every 1.5 seconds is
not a poll.

Ghostty puts no tty on a surface, and the tty is the join everything else is built on, so a
Ghostty tab is matched to a session through the ttys its own GUI process hosts - and only
where exactly one match is possible. Two Ghostty tabs open on the same directory with an
agent in each are ambiguous, and **neither is named** rather than one being guessed: a
wrong match would raise someone else's tab and type your next prompt into it.

A matched Ghostty session is discovered, named, **typed into** and **focused** - replies,
queued prompts, the send chord and Focus all reach the surface. Two things it cannot do, and
both are Ghostty's own limits rather than missing plumbing. **Rename** refuses, saying so
("Ghostty can't retitle a tab"): its titles are read-only on every window, tab and surface,
so a tab it opens carries whatever the shell reports. And its **screen cannot be read**, so
anything built on reading a pane back is unavailable on a Ghostty session rather than quietly
wrong: the permission-mode chip, dialog detection, and the read-back that confirms a pasted
prompt was actually submitted. Run the agent under tmux, inside a Ghostty window or anywhere
else, if you want those too.

### Session runtimes (terminal, or the Agent SDK)

Everything above answers "which terminal holds this session". A separate question is how
Mission Control *talks* to it at all, and until now every session answered it the same way:
through a pane. That is a session's **runtime**, and there are two.

- **Terminal** - the default, and what every session you start yourself always is. Delivery
  is a bracketed paste and an Enter; a permission prompt is a menu read off the screen.
- **Agent SDK** - the daemon runs the agent itself: Claude Code through
  `@anthropic-ai/claude-agent-sdk`, Codex through `codex app-server` (JSON-RPC over stdio).
  There is no pane. A submitted message is *acknowledged* as a new turn, added to Codex's
  current turn, or queued behind Claude's current turn. Both the conversation reply box and
  the compact Send box show that disposition, so accepted input does not disappear while an
  agent is busy. A permission prompt or an approval arrives as data - what is being asked,
  and the exact rows to offer - which the card renders directly.

For dispatched Claude and Codex sessions, **Agent SDK is the recommended runtime**: it
replaces probabilistic paste-and-Enter delivery and screen-scraped questions with
acknowledged turns and structured requests. Terminal is not a deprecated operator surface:
sessions you start yourself are always terminal-backed, and terminal-runtime dispatch
remains an explicit per-harness choice. The shipped defaults are unchanged.

The runtime is chosen **per harness, in Settings → Harnesses**, and it is read at dispatch
time, so flipping it mid-batch reaches the next session you launch. It ships as `terminal`
for every harness and stays there until you change it: there is no per-task override and no
default flip. It is also scoped to dispatch, exactly like the model and effort defaults next
to it - a Claude session you started yourself is pane-backed whatever this says, because
Mission Control does not own your terminal.

**What changes when you turn it on.** A dispatched session appears as a card with no
pane string under its title (it wears an `◈ Agent SDK` chip instead), and:

- the task's prompt is the conversation's first turn - there is no paste to verify, no
  settle window, and no retry that can make an agent read its task twice;
- permission prompts and plan approvals render as one-click rows on the card. A single
  `AskUserQuestion` keeps those one-click choice rows and adds a separate custom-answer
  field; multi-question or multi-select asks show every question together and submit once.
  Each question accepts either its choice rows or non-empty custom text, and parallel asks
  wait their turn on the same card instead of replacing one another. Claude's own question
  tool is left enabled - the MCP ask-channel redirect exists because a menu on a child's
  terminal is unreadable, and here it is not;
- the permission-mode and reasoning-effort pickers control the live embedded conversation,
  just as they control a pane-backed one;
- the transcript still comes from the same session file the interactive CLI reads -
  `~/.claude/projects/…` for Claude, the `~/.codex/sessions/…` rollout for Codex, which
  `thread/start` hands the daemon directly. Goal, cost and PR state reaches the same card
  fields through those files and the driver, so those surfaces keep working too;
- **Focus** is replaced by **Continue in terminal** (below).

**What it costs.** One real regression: the subprocess is the daemon's child, so restarting
the daemon interrupts whatever turn was in flight. The conversation itself survives - the
supervisor records the session and resumes it on the next start, before anything else runs -
including its Mission MCP tools - but the interrupted turn's remaining work has to be
re-prompted. In exchange, delivery stops being probabilistic and menus stop being screens.

**Automation works here, and works better.** Foreman reviews, answers and drives the work
queue on an embedded session exactly as it does on a pane-backed one, over the same routes -
and the differences all fall the same way:

- a queue item is delivered by one acknowledged call, so an item either was delivered or
  definitively was not. There is no "it may be sitting unsubmitted in the composer" state to
  hand back to you, and no waiting out someone's scroll-back;
- Foreman answers a structured ask by naming the option, and a multi-question
  `AskUserQuestion` by filling the whole form in one submission. On a terminal that form is
  refused outright - pressing a row only ticks a box - so this is an ask it can now answer
  rather than escalate;
- prose is deliverable. A terminal menu discards typed characters, so an answer that named
  no row could not be sent at all; an embedded ask takes free text where a question invites
  it, and takes "no, and here is why" as an answer;
- an embedded session is instrumented by construction - the driver *is* the pickup and
  completion channel - so it never has to wait to have reported a hook before it can hold a
  queue;
- **Reset** clears the conversation through the driver, and the wrap-up skill and the
  skills-reload broadcast reach it the same way. Cost is still read from the same OpenTelemetry
  stream the interactive CLI emits, counted once.

(The full design and its tradeoffs are in `docs/plans/agent-sdk-sessions/plan.md`.)

#### What an embedded Codex session does differently

Codex speaks a different protocol, and two of its answers are its own rather than the
runtime's.

- **Approvals, not permission prompts.** Codex asks when a command needs to escape its
  sandbox - network access, a write outside the workspace. That arrives as the same
  three-row ask (**Yes** / **Yes, and don't ask again** / **No**) on the card, carrying the
  command and the directory it would run in, and answering it releases the turn. If Codex
  also asks a question (`request_user_input`), it renders as a form exactly as Claude's
  does.
- **The permission profile is partly fixed for the life of a thread.** Approvals and the
  reviewer are per-turn settings, so switching between **Ask for approval** and **Approve
  for me** takes effect on the session's next turn. The *sandbox* is not: Codex cannot move
  a running thread between `read-only`, `workspace-write` and `danger-full-access`, so
  picking a profile that would need a different one is refused with a sentence saying to
  continue in a terminal and use `/permissions`. The card's profile chip is read back from
  the rollout either way, so it always shows what the agent is really running under.
- **Auto mode on dispatch** gives an embedded Codex the same posture it gives a terminal one
  (`workspace-write` with approvals on request), with approvals routed to you rather than to
  Codex's own auto-reviewer - the point of the runtime being that you can answer them.
- Codex's launch-scoped hooks are not injected: the event stream reports everything they
  did, so an embedded session needs neither them nor the
  `--dangerously-bypass-hook-trust` that rides with them. A Codex session dispatched in a
  terminal is unchanged.

The app-server protocol is experimental upstream. Its TypeScript bindings are generated from
the installed binary and committed (`src/server/harness/codex/app-server/protocol.ts`,
regenerated with `node scripts/codex-app-server-bindings.mjs`); a Codex upgrade that moves a
field is a regenerate-and-read-the-diff, not a hunt.

#### Continue in terminal

`⇧P`, or the button where **Focus** sits on a pane-backed card. It stops the driver and
reopens **the same conversation** in a terminal home in the same checkout -
`claude --resume <session id>` or `codex resume <thread id>`, whichever harness the card is.
Both vendors keep one session store across their programmatic and interactive surfaces,
which is what makes this a handoff rather than a lost conversation. Discovery adopts the new
process, and the task's binding follows it across even when discovery takes longer than the
handoff request waits.

It is one way. After the handoff the terminal session is the one holding the conversation;
the embedded card goes away. Nothing is lost if the terminal cannot be opened - the error
tells you the exact resume command to run yourself.

### What each agent can do is declared, not assumed

Claude Code, Codex and Pi are not the same product, and several features below reach
only the harnesses that support them. Rather than testing "is this Claude?" at each place,
every agent **declares** what it has: permission modes, skills, work queues, reasoning
effort controls, a command that clears its context, an MCP client. Absent is a first-class
answer.

That is why the differences you see are consistent rather than piecemeal. A Codex card
draws its permission picker using Codex's native `/permissions` menu, while
<kbd>⇧</kbd><kbd>Tab</kbd> still does nothing because Codex has no mode cycle to walk; its
work-queue drawer is available once that session's launch-scoped hooks have reported, so
[Foreman](#foreman-auto-responder) can observe and drive it; and the
[skills](#skills-every-session-mixed-reload-behavior) catalog links a skill into each
harness's own directory while nudging only the one that needs telling. Where the capability
*is* there the branch disappears entirely: a **reset** of a Codex checkout clears its
context with the same `/clear` a Claude one gets, because Codex declares that command too.

The declarations move as the harness does, and a capability is filled in only after it has
been pointed at a real install. Several of Codex's were `null` on the strength of a
plausible-sounding claim and turned out to be wrong when someone checked - it draws
readable option menus, its session file parses into conversation turns, it speaks
`/clear`, and it has a skills directory of its own. Each of those was one entry in a
record, and correcting it lit the feature up everywhere at once with no component and no
stylesheet touched.

The dashboard is declaration-driven too, down to the paint. An agent states its own
name, transcript byline and brand colour (`AGENT_IDENTITY`, `src/shared/agent.ts`), and
the stylesheet mentions no agent at all - the colour arrives as one `--agent-accent`
custom property, so a new harness colours its dot and its transcript byline with no CSS
written. Everywhere a sentence has to say *which* agents a feature reaches - the dispatch
form's agent picker, the skills rows, the auto-mode switch, the empty grid - that list is
computed from the capability, never typed out.

Adding a third agent means filling that declaration in. The types make it impossible to
add one and quietly inherit Claude's answers, and nothing about it needs a component or a
stylesheet edited to show up. **Pi** (`@earendil-works/pi-coding-agent`) is that third
agent, added as the migration's acceptance test: it discovers, names, focuses and takes
typed input, all from declaration alone. Its session format parses as rich conversation,
but an operator-started process supplies no identity that can safely bind it to one file.
Mission Control-dispatched Pi sessions receive an exact native session id and can use
transcript-derived state; operator-started ones visibly degrade to no transcript. It disables
what it lacks in the open: no MCP client, no work queue without hooks, and no permission-mode
chip, because its `manual`/`auto`/`readonly` approval modes are its own vocabulary rather than
the ones the chip is built for. The spike and the interface couplings it surfaced are written
up in `todo/pi-harness.md`.

### Precise status (Claude hooks)

Passive discovery can tell a session is *alive*, but process discovery alone cannot
say whether the agent is actively working, sitting idle, or waiting on you. Claude
Code **hooks** close that gap: a tiny bridge reports each lifecycle event to the daemon
so every card shows a live, precise state and a one-line activity. Codex can also
confirm working and idle passively from explicit lifecycle markers in its rollout file;
its hook-only safeguards remain separate, as described below.

**1. Install** (idempotent - it merges into `settings.json` in place, rewriting
only the hook arrays it changes, so your other settings, your own hooks, and
even comments are preserved; re-running when nothing changed doesn't touch the
file):

```sh
npm run install-hooks
```

Expected output:

```
Wired Mission Control hooks into /Users/you/.claude/settings.json
  events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, PreCompact, SessionEnd
  script: /Users/you/workspace/ai-harness/hooks/harness-hook.mjs
```

This adds one `command` hook per event to `~/.claude/settings.json`, each running
`hooks/harness-hook.mjs` with the event name. The bridge is fast, writes nothing
to stdout, swallows every error, and always exits 0, so a hook never blocks or
fails the agent even when the daemon is down.

Which events those are, and what each one means for a card, belongs to the agent rather
than to the installer: both live on `HARNESSES.claude.hooks`
(`src/server/harness/claude/hooks.ts`), which this script and the packaged app's
**Install Claude integrations…** both read. Only the payload mapping - Claude's hook JSON
keys - is in the bridge itself; the transport under it
(`src/shared/hook-bridge.mjs`) names no agent. An agent that reports nothing declares
`hooks: null` instead, and its cards are read passively, off discovery and whatever its
own session file says. Claude and Codex report hooks - Codex by a different route,
[below](#precise-status-for-codex-hooks-that-ride-on-the-dispatch). Pi declares
`hooks: null`; only a Mission Control-dispatched Pi has the exact transcript binding needed
for passive working/idle state.

**2. Start a new Claude Code session.** Claude reads hook config when a session
starts, so **sessions already running when you install won't report until you
restart them.** This is the #1 reason a busy agent is stuck on grey "running"
right after installing - the fix is simply a fresh session (or a full Claude
restart), not a code change.

**3. Verify.** In a new session, run anything; its card should flip from grey
**running** to blue **working** within ~1s. Or ask the daemon directly:

```sh
curl -s http://127.0.0.1:7317/api/sessions | grep -o '"instrumented":[a-z]*'
# "instrumented":true  while the session has fresh hook evidence
```

**Uninstall** (removes only our entries, leaves your other hooks intact):

```sh
npm run install-hooks -- --uninstall
```

This also clears any `mission-*` and `fleet-*` skill links out of `~/.claude/skills` as a dev-teardown
convenience, so a checkout you're walking away from leaves nothing loaded in Claude. It
does not turn the feature off: the config still says the skills are on, so a daemon
started from this checkout re-creates them. To switch skills off for good, use the
master switch in Settings → Skills.

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

Each fired hook POSTs `{ agent, event, sessionId, cwd, env }` to
`http://127.0.0.1:7317/hooks/<event>` with the `~/.mission-control/token`. The daemon
binds it to the right card via the terminal pane env (`TMUX_PANE` /
`WEZTERM_PANE`) and maps the event to a state (see the table below). `agent` is what says
whose event vocabulary `event` is written in: a pane outlives the agent in it, so an
event is only ever applied to a card running the harness that sent it. It defaults to
`claude` when absent, since a bridge installed by an older checkout predates any other.

</details>

### Precise status for Codex (hooks that ride on the dispatch)

Codex reports too, and its ten events are declared on its own harness
(`src/server/harness/codex/hooks.ts`): `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `Stop`, `PreCompact`, `PostCompact`, `SubagentStart`
and `SubagentStop`. `PermissionRequest` is the one worth naming: it is Claude's
`Notification` by another name, the single event that means *a human has to answer this*,
so it maps straight to amber **needs input** rather than being swept into the working
fallback. Nothing else fires while a session is parked on it, which is exactly when a card
must not read as busy.

**There is nothing to install, and that cuts both ways.** Claude's hooks are written once
into `~/.claude/settings.json` and every session on the machine reports from then on.
Codex's are **launch-scoped**: the dispatcher builds one `-c hooks.<Event>=[…]` override
per event, pointing at the bundled bridge (`dist/satellites/codex-hook.mjs`, overridable
with `MISSION_CODEX_HOOK`), and passes them on the command line. So a **dispatched** Codex
session is instrumented from its first breath, and a Codex session **you** started
yourself sends nothing but still reports confirmed **working** and **idle** states from
explicit lifecycle markers in its rollout file. That passive evidence is enough to place
the session in the right board column; it does not enable readiness, prompt delivery,
task handover, queues, or other safeguards that specifically require live hooks. If the
bridge bundle is missing - `npm run build` never ran - the launch drops the overrides and
runs uninstrumented rather than failing.

Those overrides ride with `--dangerously-bypass-hook-trust`, and never without them.
Codex would otherwise stop at a trust prompt for hooks the dashboard itself just injected,
and a dispatched session has no human at the keyboard to answer it. The flag is
process-wide for that one launch, so it also clears hook trust for anything the dispatched
checkout's *own* Codex config declares - which is why it is spent only on a **dispatch**,
a launch you asked for into a repo you picked, and never on a session you started
yourself or on one the app merely discovered.

### Status line (optional)

Claude Code runs your `statusLine` command on every terminal render and pipes it a payload
the hooks never carry: the live model, thinking level, context window, and your
subscription's rate-limit windows. Wrapping that command lets the daemon read it too:

```sh
npm run install-statusline             # installs the hooks above, and wraps the status line
npm run install-hooks -- --uninstall   # unwraps it again (restoring your own command)
```

The wrapper delegates to whatever status line you already had - recorded in
`~/.mission-control/statusline-inner`, or `ccstatusline` if you had none - and prints only
that command's output, so your terminal looks exactly as it did. It is never installed for
you: a plain `npm run install-hooks`, and the packaged app's integrations, leave
`statusLine` untouched.

It makes the model / thinking / context figures on the cards exact (without it they come
from a passive transcript read), and supplies the [cost telemetry](#cost-telemetry) plan
meters for terminal Claude sessions. Embedded Claude SDK sessions have no terminal status
line; they fetch the same account windows through the SDK instead.

When Mission Control can safely read and write the live session, its thinking badge is
also a picker: click it to see the effort levels Mission Control can safely apply to the
selected model and choose one for that session. A successful change uses the harness's
native session-only control; it never changes that harness card's **Effort** select in
**Settings → Harnesses** or what future sessions start with. Until the current model and
effort have a trustworthy passive baseline, or when the pane cannot be written, the badge
stays read-only. The same picker appears on Cards, in Console detail, and on Board tiles.

### Session status colors

Each card's status badge and its left edge stripe encode the session's state:

| Color | State | Meaning |
|-------|-------|---------|
| 🔵 blue | **working** | agent is actively running a prompt or tool |
| 🟢 green | **idle** | alive, waiting at an idle prompt |
| 🟠 amber | **needs input / needs review** | the agent (or a review item) is blocked on you |
| 🟠 amber | **needs an answer** | the session is parked on an [option menu](#answer-a-sessions-menu-from-the-dashboard) |
| ⚪ grey | **running** | alive, but precise state unknown - hooks aren't reporting |
| ⚫ dim | **exited** | the process is gone |

Blue / green needs a trustworthy lifecycle source: the [Claude
hooks](#precise-status-claude-hooks) you install once, the [Codex
hooks](#precise-status-for-codex-hooks-that-ride-on-the-dispatch) that ride on a dispatch,
or an exactly bound passive transcript such as a Mission Control-dispatched Pi session.
Without one, a card shows grey **running** - with one exception: **needs an answer** is read
off the terminal itself, so a session sitting on a menu goes amber whether or not it's
instrumented. That exception is the point: an uninstrumented session waiting on a
permission prompt is the most blocked thing on the board, and it used to report as grey
running forever. **Needs input / needs review** still comes from hooks or a review item.
The small colored dot next to each title is *not* a status - it's the brand color the agent
declares for itself (terracotta for Claude Code, green for Codex, blue for Pi).

Claude and Codex sessions carry a **permission mode** chip. Claude offers `manual`, `accept
edits`, or `plan` on the standard cycle, plus `bypass` / `auto` / `don't ask` for sessions
that enable them; <kbd>⇧</kbd><kbd>Tab</kbd> still cycles those modes. Codex offers its
native **Ask for approval**, **Approve for me**, **Full Access**, and **Read Only** profiles
through `/permissions`.
Clicking either chip opens the same dashboard picker and drives the harness's own control.
Like the thinking badge, it appears on Cards, in Console detail, and on Board tiles, so
triaging from the board does not mean opening a session to change its permissions. Before
Codex writes its first observable mode, the neutral `permissions` chip still opens the
picker. When the pane cannot be written the chip stays read-only.

### Open a terminal, or the agent's own CLI, on a session

Above every conversation sits the worktree that session is working in, and two buttons.

**Terminal** opens your login shell (`$SHELL`, else `/bin/sh`) in that worktree. Its menu
lists the four registered backends - **tmux**, **cmux**, **WezTerm** and **Ghostty** - and
reports which this machine can use. An unavailable backend stays listed with a **sentence**
saying why, because "not installed" and "installed, but nothing here can show its windows"
are different things to go and fix. tmux is the second of those: `tmux new-session` opens
**detached**, so its row is enabled only when an emulator is present to raise it, and then
says which one it will use. A button that reported success and put nothing on screen would
be worse than no button.

The **agent button** puts you on that conversation. Its shape follows what is safe: it is a
plain button when a live pane can be focused, and otherwise opens the same terminal chooser
as **Terminal** so you can pick where the resumed CLI appears.

Its behavior changes with the session:

- The session **already runs in a terminal** - it has a pane. Then the button has no menu
  at all; it takes you to that terminal. Opening a second `--resume` beside a live pane would
  put two agent processes on one conversation file, which no harness arbitrates.
- The session is [embedded](#session-runtimes-terminal-or-the-agent-sdk). **Continue in
  terminal** opens the chooser, stops the live driver, then reopens that exact conversation
  through the existing handoff lifecycle in the backend you selected.
- The agent has **exited**, but its checkout and conversation id survive. Its old pane
  handles are stale, so the chooser resumes the CLI in the selected backend. The daemon
  claims that resume exclusively and transfers any active task and terminal-resource
  ownership before the replacement session appears.

A session whose checkout the daemon could not read renders **Terminal** disabled with the
reason. A handoff or resume is disabled until it has both a checkout and a conversation id;
a live pane remains focusable without either. If the harness cannot resume the conversation,
the disabled agent button says so.

This appears on **every layout that shows a conversation** - Cards, Console detail, and the
Board's drilled-in pane - because it lives in the conversation panel itself rather than in
any one card.

### Answer a session's menu from the dashboard

When a session stops on an option menu - a **permission prompt**, an `AskUserQuestion`
clarification, a **plan decision**, the folder-trust check - the card renders that menu's
rows as **buttons**, with the question above them and each row's description beneath it.
Click one and the daemon answers it in the terminal. Not just plan mode, and not only the
ones Foreman declined: **every** menu a session is parked on is offered.

A **multi-select** `AskUserQuestion` renders as **checkboxes with a Submit button** instead,
because it is a form rather than a menu: in the terminal, Enter on one of its rows only
ticks that row's box, and nothing reaches Claude until its `✔ Submit` tab is confirmed. Tick
any number of rows, press **Submit answers**, and the daemon ticks what differs and walks
Claude's own submit path. If Claude has further questions, the next one takes the card's
place and you answer it the same way; if its review tab reports a question still unanswered,
the form is left up rather than sent half-filled.

This works for **Codex sessions too**, and that matters most for the ones nothing
instruments: Codex's hooks [ride on a
dispatch](#precise-status-for-codex-hooks-that-ride-on-the-dispatch), so for a Codex
session you started yourself a menu read off the pane is the *only* evidence Mission
Control can have that it has stopped and is waiting for someone. Its command-approval
prompt, its directory-trust check and its update prompt all render as buttons exactly like
Claude's. Each agent declares how its own screen reads (`harness.tui`), which is what lets
one grammar serve both - they differ, it turns out, by a single cursor glyph.

The menu is read straight off the pane on the same ~1.5s sweep that reads the permission
mode, so it needs **no hooks** and costs no extra work - and it clears the moment the menu
does. On a menu the card also marks the row the terminal's own cursor is on, so this view
and a tab open on the same session never disagree about what Enter would do. A dialog whose
pane stops being readable - the window closed, the tmux server restarted - clears within a
few sweeps rather than lingering as rows nothing can reach.

**The reply box is closed while a menu is up**, deliberately. A dialog isn't a text box: it
discards typed characters, and the Enter that follows confirms whichever row was already
highlighted - so a reply sent at a menu doesn't fail, it silently answers with the default
under your name. The buttons are the only safe way to answer one.

Because the card's copy of the menu is up to one sweep old, a click sends back the **label**
you were shown and the daemon re-reads the pane before pressing anything: if the screen has
moved on - the menu closed, the rows repainted, [Foreman](#foreman-auto-responder) got there
first - the click is **refused and nothing is pressed** rather than landing on the wrong row.
That also makes racing Foreman safe, which is why every menu is offered rather than waiting
tens of seconds to see whether Foreman handles it.

### Scrolling a pane back pauses writes into it

Scroll a session's **tmux** pane back and tmux puts it in **copy-mode**, where it routes
every keystroke to itself: `send-keys` and `paste-buffer` both report success while the
agent receives nothing. So the daemon reads the pane's mode before it types and **refuses**
the write instead, naming the mode - a reply, a menu click, a
<kbd>⇧</kbd><kbd>Tab</kbd>, a queued item and a skills reload all wait rather than
vanishing. It refuses rather than dropping you out of copy-mode, because a pane in it is a
person reading their own scrollback. Leave it (<kbd>q</kbd>, or scroll back to the bottom)
and the write goes through on the next attempt; Foreman retries a parked queue item on its
own, and doesn't spend one of that item's delivery attempts on you.

The one case that isn't a clean no-op is scrolling *while* an item is being delivered: the
prompt is pasted, then the Enter that submits it is swallowed. The text is sitting in the
composer unsubmitted, and the error says exactly that - leave copy-mode and press
<kbd>Enter</kbd> yourself rather than re-sending, which would paste a second copy.

### Reading a session's whole conversation

The Conversation tab opens on the session's **recent** turns, and scrolls back through the
rest on demand. A card open reads a bounded tail rather than the file - a long session's
transcript runs to tens of megabytes, most of it tool output - so the panel is quick to
open whatever the session has been doing.

Scroll to the top of the log and the page above loads automatically, then the page above
that, back to the session's first turn. **Load older messages** does the same on click,
for when you would rather not scroll. Nothing appears once you reach the beginning: a
short session shows no control at all.

What you have scrolled back to is kept for recently viewed sessions, so switching to the
Diff tab and back, collapsing a card, or moving between sessions usually returns you to
the history you had - not to the tail again. The cache lasts for the browser tab; an
evicted entry can always be fetched again by scrolling up.

A dropped connection or a daemon restart costs you nothing either: the panel reconnects
by telling the daemon how far it already has, and gets back only the turns written while
it was away. Your place in the conversation does not move. It starts over from the recent
turns in two cases only - the transcript was cleared or replaced under it (a `/clear`), or
the agent wrote more than a reconnect can honestly be said to have missed. Both are the
honest answer rather than a continuation with an invisible hole in it, and scrolling up
re-reads whatever was dropped.

### Shadow reading: Claude's own session state

Claude Code ships `claude agents --json`, which lists every live session - background and
interactive, including ones you started by hand - with `pid`, `sessionId`, `cwd`, `status`
(`idle` / `busy` / `waiting`) and `waitingFor` (`permission prompt` vs `input needed`).
That overlaps three things this daemon works out the hard way: the `ps`-to-tty-to-pane
correlation, the permission-mode footer parse, and the heuristic that decides whether a
notification is a real question or an idle nudge.

It is **not** wired into discovery, because on the machine this was written on the two
views joined 11 of 11 sessions by `sessionId` but agreed on state for only 7 of them. The
join rate says the identity plumbing is redundant; the disagreement rate says the state is
not a drop-in replacement, and some of those gaps are probably bugs on our side - this is
the first time there has been a second opinion to check against.

So it runs as a **shadow**: off by default, and when on it only logs.

```bash
MISSION_AGENTS_SHADOW_MS=30000 npm run daemon
```

```
[agents-shadow] mission=6 claude=17 joined=6 unjoined=0 agree=3 disagree=3 skipped=0 claude-only=11
[agents-shadow]   sid=ae07d2ea pid=68926 mission=working claude=idle
```

`skipped` is counted separately so `agree + disagree` is never mistaken for the whole
population: it covers records Claude reported without a status, and sessions in a state
Claude has no analogue for (`awaiting_review` is a Foreman concept). Codex sessions are
excluded entirely - `claude agents --json` cannot see them. `claude-only` is the count of
sessions Claude knows about and this daemon does not, which is usually background agents.

Nothing here changes behaviour. It exists to turn "should we adopt this?" into a decision
backed by days of data rather than one sample.

### Goal

Every card carries a one-sentence **Goal**: what that session is currently trying to
solve. It sits under the title, on the collapsed card - you should never have to click
to remember what a session is for.

It lands in two tiers, both in the daemon:

1. **Instantly, with no model.** The `UserPromptSubmit` hook already carries your prompt,
   so the moment you send one the card shows your own words, shortened to a line. Free,
   and the card is never blank waiting on anything.
2. **Refined, a few seconds later.** One headless model call rewrites it into one
   sentence, reading your prompt plus a small window of the conversation. Which provider
   and which model is **Settings → [Models](#models-what-the-apps-own-model-work-runs-on)**;
   out of the box that is the **local `claude` CLI, not the Anthropic API** - there's no
   API key, and it bills through whatever your CLI is logged in as.

The goal refreshes as you steer the session, at most once a minute per session. If the
provider is missing, logged out, or slow, the card quietly keeps your own words - nothing
breaks, you just get a rougher sentence.

What it deliberately isn't:

- **Not** what the session is doing this second. That's the activity ticker on its own
  line - "running Bash" is not a goal.
- **Not** derived from anything but your prompts. Background task notifications arrive
  through the same hook and are filtered out; they're actually the majority of it.
- `/clear` starts a new session, so it wipes the goal; `/compact` keeps the same session
  and leaves it alone.

**Codex cards carry a Goal too**, and both tiers reach them: a Codex session reports your
prompt over its own `UserPromptSubmit`, and the refiner reads the same rollout file the
transcript does, so there is a conversation window to summarise from. Tier 1 is what
starts the whole thing, so this needs the hooks - an uninstrumented Codex session (one you
started yourself) has no prompt to show and stays blank, the same way an uninstrumented
Claude session does. Pi can read conversation turns too, so it has no permanent
`GOAL_UNSUPPORTED` refusal; it does not yet push a prompt event, however, so current Pi
cards do not seed a Goal. The permanent-refusal map is null for all three harnesses, and
only agents whose harness can never read turns get an unsupported sentence.

### Cost telemetry

You run a fleet; this values its usage consistently without pretending a subscription has
a per-request dollar bill. Codex estimates are automatic. Claude's client-calculated
estimate stream is off by default; switch that on in **Settings → Cost**, or from the CLI:

```sh
npm run install-telemetry     # adds an env block to ~/.claude/settings.json
npm run install-hooks -- --uninstall   # removes that block - and the hooks, and the
                                       # status line wrapper. To switch off only the
                                       # cost telemetry, use Settings → Cost.
```

Once either source has data, every priced card carries a **cost badge** beside its model /
thinking / context row, and the topbar grows a foldable **Usage** row:

| Figure | What it is |
|---|---|
| **Estimated cost today** | Claude- plus Codex-estimated API-equivalent usage since local midnight |
| **Estimated rate** | the last hour of that same combined estimate |
| **Tokens today** | input, output and cache, every tier summed |
| **Cost / PR** | today's combined estimate over pull requests either agent opened today. Counts only PRs we can [prove we opened](#inspector-automated-pr-review) |
| **Runway** | per rate-limit window: how long it lasts at the pace it has been spent so far. The bar is consumption, the figure beside it is the projection. Each row names the provider whose quota it is, since Claude and Codex report their own |

The runway is the only forward-looking number in the app, and it is an average
extrapolated forward - which is why it is written `~41 min`, and why a window the current
pace does not exhaust reads **clears** rather than a made-up time. It is projected from
the window's own percentage and nothing else: the estimated cost rate and the quota are different
meters, so deriving one from the other would be a confident number about the wrong thing.
An average cannot see a burst; a fleet that idled all morning and then started six
sessions reads as calm for a while.

Folding the row away keeps today's estimate visible beside the toggle, and the choice
persists per machine like the layout.

Four transports feed the strip, each kept to the facts it actually reports:

| Source | Provides |
|---|---|
| **OpenTelemetry** | Claude Code's locally calculated `claude_code.cost.usage` estimate and `claude_code.token.usage` by tier, per session, model, and `query_source` |
| **statusLine payload** | your Claude subscription's `five_hour` / `seven_day` rate-limit windows for terminal sessions; OTel has no quota metric |
| **Claude Agent SDK usage** | the same account windows for embedded SDK sessions, refreshed when the session resumes after a daemon restart and after each completed turn |
| **Codex rollout file** | quota windows plus request-level `last_token_usage`, including model, cached input, cache writes, output, and reasoning output. A durable byte cursor and event identity make restarts/replays idempotent |

Terminal Claude plan meters need the [opt-in statusLine wrapper](#status-line-optional)
(`npm run install-statusline`); embedded Claude SDK sessions repopulate them automatically.
That SDK lookup is optional live enrichment: a failure neither interrupts the session nor
clears the last valid account gauge, and it never writes cost - OpenTelemetry remains Claude's
one cost ledger. The estimated-cost figures don't need the wrapper, and Codex's windows need
neither - they ride in the exact rollout file reported by app-server and read by the same
runtime metadata poller that supplies model and context figures. Telemetry and the terminal
wrapper remain separate opt-ins because they are two different asks of your config - one adds
an `env` block, the other rewrites the command that draws your terminal line. Only `--telemetry`
adds the block and only `--uninstall` removes it: re-running `npm run setup` or any other
installer leaves an existing block exactly as it found it, so **Settings → Cost** stays the one
switch.

A plan meter disappears once its window resets rather than holding the last percentage -
a quota that has already rolled over is not a figure worth showing, and the same rule
already governs an account with no rate limits to report.

**Every dollar figure is one API-equivalent estimate and is marked `≈$`.** Claude Code
calculates its rows from request usage; Mission Control prices Codex requests at an
immutable snapshot of OpenAI Standard API rates, including cache and long-context rules.
Estimator provenance remains on each session, but both values have the same economic
meaning: neither is Pro, Max, or ChatGPT plan spend, credits consumed, or an invoice. If
any row in a fleet window has no verified price, that window reads **partial** and cost/PR
is withheld rather than presenting a known subtotal as the complete estimate.

Enabling it writes six keys into your `~/.claude/settings.json` `env` block (see
[Configuration](#configuration)); the edit is surgical, your other settings and comments
are left byte-for-byte intact, and switching it off removes only the keys it added. It
has to be a settings-level `env` rather than a per-spawn variable because Mission Control
sees sessions it didn't start.

Ledger rows are kept for **180 days** and pruned by age alone - a finished session's cost
is exactly when the record starts being interesting.

Codex ingestion covers the main rollout only. Separate subagent rollouts are not assigned
to a parent by cwd or timing because that relationship is not proven. The standard-price
snapshot currently recognizes `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and
`gpt-5.5`; a new model intentionally stays unpriced until its official rate is added.
Claude's estimate can include provider-priced server tools such as web search; Codex
rollouts do not currently expose every separately billed hosted-tool fee.

### Review channel (MCP)

```sh
npm run build                    # builds the MCP server bundle
claude mcp add -s user mission-control -- node /ABSOLUTE/PATH/dist/mcp/server.mjs
codex mcp add mission-control -- node /ABSOLUTE/PATH/dist/mcp/server.mjs
```

(`npm run install-hooks` prints the exact `claude` command with your paths. The desktop
app's **Install Claude integrations…** does both at once, because each harness declares its
own CLI, its own env flag and whether it even has a scope to register under - Codex has one
registration and no `-s user|project` to choose between. A harness with no MCP client at all
would be reported as such rather than silently skipped.)

> **Adding or changing a tool means rebuilding the bundle.** Both the registration above and
> the dispatched-session `--mcp-config` launch the *built* `dist/mcp/server.mjs`, never
> `src/mcp/server.ts` directly - so a new or edited tool in the source is invisible to every
> session until `npm run build` (or just `npm run build:mcp`) refreshes that file, after which
> you start a **new** session to pick it up. Re-running `claude mcp add` is not needed: the
> registration records the *path*, and the rebuild replaces the file it points at (re-add only
> when the server *name* changes). The dev stack is the same trap in disguise - `npm run dev` /
> `make start` auto-reload the daemon from source, but the MCP bundle is not on that watch, so
> an MCP tool change still needs a manual rebuild. The tell is a session whose `mission-control`
> tool list is shorter than the set below (`create_task` missing, say): the bundle it launched
> predates the tool.

This registers a stdio MCP server (`src/mcp/server.ts`) that each session launches. It
exposes six review-channel tools (an ensemble member session also gets
[`submit_ensemble_result`](#multi-agent-ensembles):

- `share_plan(title, plan)` - show a markdown plan (non-blocking)
- `request_plan_decisions(title, plan, decisions)` - show a plan with selectable
  options (radios / checkboxes) and **block** until the human submits their choices or
  dismisses that decision set without an answer
- `request_review(title, diff)` - show a diff and **block** for approve / changes
- `create_task(title, intent, dependsOnTaskIds?, dependsOnCurrentSession?)` - add a ship task
  for the current repo to the backlog with the default agent/model/effort, returning its id so
  later tasks can carry durable dependency edges. The calling agent is usually standing in a
  worktree; the task is filed against the **repo that owns it** - see [A task's repo is the
  repo, not the worktree](#a-tasks-repo-is-the-repo-not-the-worktree)
- `request_input(question, options?)` - ask a question and **block** for the answer.
  With `options` the human gets clickable choices (radios, or checkboxes with
  `multiSelect`, plus an optional free-text "Other") and can dismiss a stale set without
  submitting it; without them, a text box
- `report_status(activity)` - update the session's activity line

Because the MCP server is a child of the agent, it inherits the terminal env and
binds every call to the correct session automatically.

Each option-based question or plan decision set is an independent review. Dismiss resolves
only that review, persists without a fabricated answer, and releases its blocked tool call.
These reviews keep the session under **Needs you** while any set remains pending; submitting
or dismissing the final set clears that review-based signal.

A review is bound to the session that asked it, so **the agent going away settles it too**.
When a session is evicted - killed, its terminal closed, or simply gone by the time the
daemon comes back up - anything it was blocked on is recorded as `orphaned` rather than left
pending. It keeps its question and body in the history; it stops being counted as somebody
waiting on you. That is deliberately not the same status as a dismiss: you declining to
choose and the agent no longer being there to hear a choice are different facts, and only
the first is evidence of your intent.

Registering it by hand as above covers sessions **you** start. Sessions the dashboard
dispatches get it automatically - see [The ask channel](#the-ask-channel).

### The ask channel

Claude sessions the dashboard dispatches into the **terminal runtime** do not use Claude's
built-in `AskUserQuestion`. It is disallowed on the spawn, and the agent is pointed at
`request_input` instead, so a clarifying question arrives as structured arguments in the
dashboard rather than as a menu drawn on a terminal nobody is watching. Agent SDK sessions
keep the built-in tool because its questions already arrive as structured driver requests;
see [Session runtimes](#session-runtimes-terminal-or-the-agent-sdk).

For the terminal runtime, four flags go on together or not at all
(`src/server/ask-channel.ts`): `--mcp-config`
supplies the tool, `--allowed-tools` pre-approves it so calling it doesn't itself raise a
permission prompt, `--disallowed-tools` removes the built-in, and `--append-system-prompt`
carries the redirect that tells the agent where to go instead, inline.

If **anything** prevents the full set - the MCP bundle is missing (`npm run build` never
ran), or the state directory cannot be written - then **none** of them are passed and the
session keeps the built-in menu. An agent with nowhere to ask is worse than one with a menu
we can read, so every failure disarms the whole channel rather than half of it, and none of
them fails the dispatch: setting this up is best-effort, and the daemon logs which condition
it hit.

The redirect is not optional. Measured on live sessions, `--disallowed-tools` on its own
does not send the agent anywhere - it asks its question in prose and ends the turn. It rides
inline on `--append-system-prompt` rather than in a file: that flag is listed plainly in
`claude --help`, so there is nothing to probe for, and tmux passes the whole prompt through
as one unmodified argv element. That combination is verified end to end, not inferred - a
dispatched agent given a question-inviting prompt calls `request_input` with structured
options and blocks, with no permission prompt, and resumes when the review is answered in the
dashboard. The tradeoff is that a dispatched agent's `ps` line carries the prompt, which is
fine - it is a static instruction with no secrets in it.

Sessions **you** start are untouched: they keep the built-in menu, which the dashboard
still reads off the pane and answers. Codex is untouched too - these are Claude's flags.

*Which* MCP server those flags point at is decided in one place, `src/server/mission-mcp.ts`:
the built bundle's path, the runtime that can execute it (a real `node`, or the Electron
binary in node mode when there isn't one), and the name it is registered under. Claude reads
that as a `--mcp-config` file; Codex, when a launch asks for it, reads the same answer as
`-c mcp_servers.mission-control.*` overrides. Either way it is scoped to that one launch and
leaves whatever **Install integrations** registered machine-wide alone.

## Dispatch an agent

The dashboard isn't just a mirror - you can launch new agents from it. Click **＋
Dispatch** (or press <kbd>+</kbd>), pick a repo, describe the task, and the daemon:

1. provisions an **isolated worktree** for the task (a pooled
   [treehouse](#isolated-worktrees-per-session-treehouse) tree when the repo opted in,
   else a plain `git worktree` on a fresh `harness/…` branch - so an agent never shares
   a working tree with another session),
2. resolves the chosen harness's [session runtime](#session-runtimes-terminal-or-the-agent-sdk)
   at launch, then takes exactly one path. **Terminal** launches the agent
   (`claude`/`codex`/`pi`) in a terminal home rooted there - a named multiplexer home when
   one is installed (tmux adds a second **shell pane split beside it** for ad-hoc
   git/build/inspection), or a terminal tab in that worktree when no multiplexer is
   available. It waits for that exact discovered session to become ready, verifies it is
   still live, and injects your task as its first prompt. Pi instead receives both a
   generated session ID and the task through its native positional launch message, which Pi
   submits after initializing its TUI. Mission Control binds that generated ID for later
   transcript attribution without waiting for Pi's lazily-created session file or injecting
   the prompt into the pane a second time. **Agent SDK** (Claude and Codex today) instead
   starts the embedded driver with the task as turn one. It creates no terminal home and
   needs no discovery, readiness wait, paste, or delivery retry; the driver's binding is the
   readiness signal.

If either launch path cannot prove it started as requested, dispatch fails instead of
calling an unverified task running.

**Model** starts on the default configured for the chosen harness (see [Default
model](#default-model)) and names it, so you can see what the task will run on without
opening Settings. Pick a different one to override it for this task alone - more
horsepower for a gnarly refactor, something cheap and fast for a one-line fix - and the
daemon passes that model through the selected runtime (`--model <id>` in a terminal,
the driver's model option on the Agent SDK). Switching **Agent** resets the model,
since model ids are harness-specific. Leaving the named **Default - …** choice selected
stores no model at all rather than pinning today's, so a task you shelve now picks up the
default in force when it's actually dispatched.

**Effort** sits immediately after Model and follows the same rule: it starts on the
chosen harness's default, can be overridden for one task, and switching Agent resets it.
Terminal-runtime Claude launches with `--effort <level>`; an embedded Claude launch passes
the same selection through the SDK and can change it live. Codex receives the corresponding
`model_reasoning_effort` launch override; Pi receives `--thinking <level>`. Leaving the
named **Default - …** choice selected keeps the task tied to the effort default in force
when it launches.

The repo picker is a **searchable index of your workspace** - the daemon scans
`~/workspace` (override with `MISSION_WORKSPACE_DIRS`) for git checkouts, so you select the
repo to base the task on rather than typing a path. Type to filter; arrow/enter to pick.

It opens on **the repo your last dispatch went to**, since work comes in runs - three
tasks into the same checkout, then a switch - and that's one fewer field to fill in for
every task but the first. The seed is remembered per-machine and survives a reload, and
it moves only when a *new* dispatch is accepted (shelving counts; saving an edit to an
old backlog task doesn't). It's a starting point, not a lock: type or pick another and
that repo becomes the seed instead.

Leave **Title** blank and the daemon names the task for you: a headless `claude -p` on
Haiku summarizes your task text into a few words - "Fix flaky worktree cleanup on Reset",
not the top of your first paragraph. It runs *before* dispatch and the dispatch waits on
it, because the title supplies the git branch and the launched session's name (including a
terminal home name on the terminal runtime), and later task-title edits do not propagate
to either. The card appears immediately under a title taken from your first line and
updates to the model's a beat later. If `claude` is
missing, logged out, or slow, that first-line title just stands - nothing breaks, and the
dispatch still goes.

The new session then shows up on the grid like any other, with an **intent chip** naming
what it's working on. A terminal-runtime session stays out of the way until you click
**Focus**; an Agent SDK session has no tab and offers **Continue in terminal** instead.
Choose **Add to backlog** instead of **Dispatch now** to shelve a task without launching
it yet.

The form leads with the brief: repo, then the task composer, with the crew row (Agent,
Kind, Model, Effort) beneath them and one shared hint in place of per-field boilerplate.
**Backlog details** - priority, labels, title, and dependencies - fold behind a summary
row that names what is set ("no priority · no labels · title summarized · no
dependencies"), so nothing the draft carries can hide; the fold opens automatically when
you edit a shelved task or the draft already holds one of them. Dependencies are chips
with a grouped **+ Add dependency** picker rather than a multi-select listbox, and an
unmet dependency raises an amber note beside them as well as renaming the primary button.
The **Single agent / Ensemble** toggle sits in the modal header, since it reshapes the
whole dialog.

**Dependencies** can be selected from tasks already in the backlog and from active
sessions. They are durable scheduling constraints, not notes: if any selected dependency
is incomplete, **Dispatch now** becomes **Schedule after dependencies** and the new task is
forced into the backlog. Every task or standalone active session completes only when its
PR is observed **merged**; merely opening its PR does not release dependents, and an
ordinary **Mark done** does not either. The explicit completion override is the exception:
use it only when the prerequisite's work is already in place (see [Resolve a stopped
dependency](#resolve-a-stopped-dependency)). Active sessions without observable hook
instrumentation are not eligible dependencies because Mission Control cannot distinguish
their next work episode from an earlier merged PR. The board and Sitrep name what a task is
waiting for, and neither manual launch, drag-to-assign, nor Foreman can start it early.
Reopen the backlog task to add or remove dependencies; cycles are refused.

Closing the dispatch form (<kbd>Esc</kbd>, a backdrop click, **Cancel**, or the ✕) **keeps
what you've typed** - reopen and a half-written task is still there, so you can glance at
the grid mid-thought without losing it. The draft is cleared only once the task is actually
dispatched or queued, or when you hit **Clear** to start a fresh one - either way the form
comes back seeded with that repo, not blank. A submit that fails leaves the form open with
your fields intact so you can retry.

### A task's repo is the repo, not the worktree

Every path that files a task - the dispatch form, the MCP
[`create_task`](#review-channel-mcp) tool, an edit to a shelved task, a [task
source](#task-sources-pulling-work-into-the-backlog) sweep - resolves what you give it to
the **main checkout**. A linked worktree resolves to the repo that owns it, so an agent
calling `create_task` from `~/.treehouse/<repo>-<hash>/16/<repo>` files against `<repo>`.

That walk-back is what makes the rest of the app agree with itself. A task's repo is what
[Foreman's allowlist](#foreman-auto-responder) is asked about before autopilot will
schedule it, and the allowlist names repos you chose - never a pooled tree, which no
operator has ever seen the path of. Store the worktree and the item is in no trusted repo,
so it is passed over on every tick, silently and forever, while the popover's ready count
(which ignores the allowlist by design) still counts it. A pooled tree is also *reclaimed*
and handed to the next agent, so the row would outlive the directory it named.

A root that **cannot** be walked back to a main checkout - a `.git` that points somewhere
with no owning repo, like a submodule or a relocated git dir - is refused rather than
written and never scheduled. HTTP task creation and edits return `400 not a repo's main
checkout` naming the path; task-source sweeps report the same refusal in their result.

### Hand a shelved task to an agent that's already running

On the [Board](#layout-cards-console-or-board), **drag a backlog card onto an idle
agent with live hook instrumentation** in the same repo and it starts there instead of in
a new worktree. A passively confirmed Codex session can appear in the Idle column without
lighting up as a drop target: the rollout proves its displayed state, but not that the
reset and prompt handover can be observed safely. The task owns no checkout of its own -
the agent keeps the one it had - which is exactly why cancelling it later never runs
`git worktree remove` over a directory the harness didn't create.

**The drop resets that agent's checkout first**, the same reset the card's **reset**
control runs: `git reset --hard` onto origin's default branch, `git clean -fd`, release
the branch, and clear the context (`/clear` for Claude Code and Codex, `/new` for Pi; an
agent that declares no clear command has its context left alone rather than being sent a
command it does not speak). Without it the next task inherits the last one's branch and
context, and no-mistakes - seeing a non-default branch - validates and pushes onto it,
putting two unrelated tasks in one PR.

So the drop **asks first whenever there's something to lose**: a dialog naming the agent's
queued work items, the branch being released, and the context being cleared, and nothing
happens until you confirm it. An agent with nothing to lose - no work queue, already
detached, which is how a pooled worktree is handed out - takes the task in one gesture,
with no dialog. What the dialog lists is what the daemon saw when it refused, not a second
look, so it can't disagree with what the confirmation then does.

**Committed work is never the thing you're asked about.** If the checkout holds anything
that isn't recoverable from origin - uncommitted files, untracked files, or commits no
`origin/*` ref has - the assign is **refused outright** and the task stays in the backlog
with a line saying what's in the way. Work that's been pushed doesn't block it: a branch
whose commits are on origin under its own ref can be fetched back by name, so an agent
that shipped is still a drop target (which is what a squash-merged PR needs, since the
landed commit has a different SHA and never appears on `origin/main`).

**The agent is renamed after the task it takes**, the way a dispatched one is named when
its session is cut - so a recycled agent's card is titled by its work rather than by
the pooled worktree it was handed out as, or by the task it finished ten minutes ago. The
name is cut to the rules of the backend *this* session lives in, which is not necessarily
the one a fresh dispatch would land on. This happens after the task has been typed, and
never fails the assign: if the terminal can't be renamed (no terminal handle at all, or
the name is already spoken for) the old name simply stands. It applies to [the backlog
autopilot's](#backlog-autopilot-foreman-schedules-the-fleet) assignments too, which
is where a stale name is most confusing - nobody watched that handover happen.

### One agent, one task at a time - but not one task per agent

**An agent runs tasks one after another, for as long as it's alive.** Finish one, take the
next: that's what recycling an agent means, and it's why the drop resets the checkout first.
What it never does is run two at once - the daemon refuses a drop onto an agent that already
has a task executing, saying which one, and the
[backlog autopilot](#backlog-autopilot-foreman-schedules-the-fleet) won't offer such an agent
work either. So an agent becomes available for its next task the moment its current one is
recorded finished, which for shipped work is when [its pull request
merges](#when-a-tasks-pull-request-merges) - not when you get round to clicking anything.
Whether that agent is then *closed* is a separate preference (**Settings → Shipping**); by
default it stays, ready for the next drop.

**Each task keeps its own record.** The card shows the task the agent is executing, or the
one it most recently finished until it takes another; the previous task keeps its own
outcome, its own pull request and its own row. That's what makes a day's work on one agent
readable afterwards rather than a single row overwritten four times.

### Edit a shelved task

**Click a backlog task and it opens back up in the form that wrote it** - on the
[Board](#layout-cards-console-or-board)'s backlog column, or by its name in the
[Roundup](#roundup) panel. Every field is editable, including its dependencies and more
screenshots dropped onto it. Put **Model** or **Effort** back on its named **Default - …**
choice to un-pin it, so the task follows the corresponding harness default when it finally
launches. **Save** keeps it in the backlog;
**Dispatch now** saves and launches it in one go, so a task you shelved half-written can be
finished and sent without a second trip. **Revert** puts back the version the daemon still
holds, and closing the form keeps your edits the same way a half-written dispatch is kept.
Clear the **Title** and it's derived afresh from the task text as you've now written it.

**A save writes only the fields you changed**, so it can't undo work you didn't touch: set a
priority on the card while this form sits open on the same task and your save carries the
title alone, leaving the priority where the card put it. And a kept edit is only kept while
the task itself stands still - if the row changed while the form was closed, reopening it
shows the task as it now reads rather than a picture of how it used to. A task whose **repo
has since gone** - a reclaimed worktree, a project moved - stays editable too; only a repo
you actually change is checked against the [task-root rules above](#a-tasks-repo-is-the-repo-not-the-worktree).

Only *shelved* work can be rewritten. Once a task is dispatched its title has already
supplied the name of a git branch and launched session, so the daemon refuses the edit
rather than let the card drift from what is running - and a task that starts while you
have it open takes the form with it.

Every dispatched task is a durable record (repo, intent, kind, worktree, branch, outcome)
persisted in SQLite, so the backlog and a running agent's intent survive a daemon restart.
Set `MISSION_CLAUDE_BIN` / `MISSION_CODEX_BIN` if the agent CLI isn't on the daemon's PATH.

### When a task's agent goes away

Kill a session with <kbd>k</kbd>, close its terminal, or let the agent exit by itself, and
the task it was running **settles as soon as the session is evicted** - roughly eight
seconds, the linger that stops one hiccuping `ps` sweep from burying a live agent. It reads
according to the [merged-PR rule](#when-a-tasks-pull-request-merges); without a recorded
merge, it reads `failed`, with `the agent's session ended with no outcome recorded`. Either
way, it drops out of every count that means "executing".

It settles; it is **not** torn down. The worktree, its branch and any terminal home name are
all kept, and the row says so (`its worktree was kept; Clean up or re-dispatch it`). Freeing
a checkout runs `git worktree remove --force` over whatever is in it, so that stays where
every other destructive path in the app puts it: behind the confirmed **Clean up** button on
the row, next to Mark done, which refuses to discard work for the same reason. A task that
never had a worktree of its own - one you handed to an agent that was already running - has
nothing to collect and says nothing about cleanup.

With no recorded merge, `failed` is the honest reading rather than a flattering one: an
agent that finished and exited looks exactly like one that crashed, and the only thing
actually observed is that the session went away without an outcome being recorded. Mark a
task done *before* the agent goes, and that outcome stands - an outcome you recorded is
never rewritten. A `failed` or `cancelled` row is not the last word, though: if its pull
request is later observed to merge, it is
[upgraded to done](#a-merge-that-lands-when-nobody-is-watching).

The same reconciliation runs against the first process sweep after a restart, which is what
catches a task whose agent died while the daemon was down.

### Hold a backlog item back

Every backlog row carries an **on/off switch**: turn it off and the
[backlog autopilot](#backlog-autopilot-foreman-schedules-the-fleet) will not schedule that
item - not into a fresh worktree, not onto an idle agent. It's on the board's backlog card
next to the priority picker, and on the same row in [Sitrep](#roundup); both draw the same
control, so you can park an item from wherever you happen to be reading the list.

**It's a hold on the machine, not on you.** **launch new agent** and dragging the card
onto an idle agent both still start a parked item; the button reads **launch anyway**, the
way it does on an item Foreman thinks is waiting its turn. Blocking a button you pressed
yourself to protect a background scheduler is the worse surprise, and it's the same call
`Max agents` makes.

That works because the switch is enforced in **two** places, and only one of them can be
opted out of. Foreman's scheduling paths never reach a parked item: both use the same ready
list, so neither the fresh-worktree launch nor the assign-onto-an-idle-agent shortcut can
see one. The daemon then refuses `POST /api/tasks/:id/dispatch` and `/assign` for a parked
item **unless the request explicitly claims an override** - which the dashboard's own
buttons do, and Foreman never does.

The refusing default is the point. The Foreman worker is a separate process you start by
hand, so it can outlive a daemon restart; one that predates this feature sends no override
and is stopped, without the daemon having to work out who it is talking to. An external
script or `curl` is refused the same way until it opts in, which is the right default for a
flag whose whole job is to stop unattended launches.

A parked card dims, says `autopilot will skip this`, and drops out of the
autopilot's `ready` count into its own `disabled` one in the Foreman popover - so an
autopilot with nothing to do can say *why* it has nothing to do rather than looking broken.
The Sitrep digest marks the row too (`- "On hold" (ship, disabled) - /repo`).

**Anything that depends on a parked item says so.** A disabled prerequisite reads as
`X is disabled` rather than `after X`, because it will never clear on its own - the same
distinction a cancelled or failed dependency gets, and both now carry their own one-click
fix instead of an investigation (see [Resolve a stopped
dependency](#resolve-a-stopped-dependency)).

**A parked item still takes part in the dependency read**, and keeps its place in the
400-item budget. Leaving it out looks like a saving and quietly breaks the paragraph
above: the planner drops any edge whose target it wasn't shown, so a parked
prerequisite's inferred dependencies would vanish on the next read and everything behind
it would go ready. Holding an item costs one plan entry it won't use, which is much the
cheaper of the two.

Like the rest of the launch configuration, the switch can only be changed while the task
is *in* the backlog; there's nothing left to schedule once it has started.

### Resolve a stopped dependency

A dependency is satisfied when it reaches `done`, or when it leaves the task list
entirely. A **cancelled or failed** prerequisite is neither: it will never finish on its
own, so everything declared or planned to wait on it sits in the backlog forever - the
state the [backlog autopilot](#backlog-autopilot-foreman-schedules-the-fleet) reports as
`blocked` with nothing in `ready`. It is a common way to arrive at a backlog that looks
full and schedules nothing: a prerequisite whose work merged under another PR, and whose
task row was then cancelled rather than marked done, strands every phase behind it.

So a dependent card carries a **warning button** (the danger-tone triangle) whenever a
stopped task is blocking it - **directly, or anywhere up its still-backlogged chain**.
The chain part matters: the card that *declared* the dead edge is not always the one you
are looking at, and a phase three links downstream is just as stuck without knowing why.
The walk stops at a prerequisite that already launched, because its earlier dependencies
no longer gate downstream work. The warning follows the blocked downstream on the board's
backlog card and on the same row in [Sitrep](#roundup), so the fix is reachable from
wherever you are reading the list.

Opening it names the stopped prerequisite and offers two ways out:

- **Reschedule** puts that task back into the backlog to run again
  (`POST /api/tasks/:id/reschedule`) - the "it still needs doing" answer. Only a
  `cancelled` or `failed` task is eligible; the row is reset to a clean, re-enabled backlog
  item (any leftover worktree reclaimed first, as `Clean up` does) so the relaunch is not
  poisoned by a stale outcome or a dead branch. The dependent's block becomes an ordinary
  `after X` wait that clears when the rescheduled work lands.
- **Mark done** records the prerequisite as complete with `satisfyDependents` set
  (`POST /api/tasks/:id/complete`) - the "its work already landed" answer, for the merged-
  under-another-PR case above. It releases the dependents immediately, and is the same
  operator override of the merge gate that [Mark done](#when-a-tasks-agent-goes-away)
  offers elsewhere.

Either action targets the *dead* task, so resolving it once frees every dependent behind
it, not just the card you clicked from.

### Priority and labels

A task can carry a **priority** and any number of **labels**. Both are optional, both
default to nothing, and neither is ever inferred - a task is marked because you marked it.

| Priority | Sorts | Reads as |
|---|---|---|
| **Blocker** | 1st | the only one in the danger colour, outlined so it is findable across a full board |
| **High** | 2nd | |
| **Medium** | 3rd | |
| *(unset)* | 4th | the default - no chip is drawn at all |
| **Low** | last | a deliberate demotion, *below* work nobody has looked at |

That ordering is the one surprising part, and it's deliberate: **unset sorts above Low,
not at the bottom**. `Low` means "I looked at this and it can wait", so it belongs under
work nobody has triaged yet - and a backlog you have never triaged keeps exactly the
oldest-first order it always had.

**Labels** are plain strings, not key/value pairs - `infra`, `flaky`, `Type: Bug`. They're
trimmed, de-duplicated case-insensitively (the first spelling wins, so a tag swept from
another system keeps its case), capped at 32 characters each and 12 per task. The dispatch
form takes them comma-separated and previews the chips you'll actually get, so a trailing
comma or a repeat is visibly a no-op.

The **backlog column** on the board sorts by priority and lets you retriage in place - the
chip on each card is a picker, and changing it re-sorts the column under your cursor. The
**Sitrep** shows both marks on every backlog row, and `Copy as markdown` carries them
(`- [blocker] "Fix the thing" (ship) {infra, flaky} - /repo`).

Priority and labels are annotation - nothing is provisioned from them - so they can be
changed at any point in a task's life, including while its agent is running
(`PATCH /api/tasks/:id`). They are deliberately *not* shown on session cards yet: the
card, rail and tile each have their own mark vocabulary and adding a fourth signal to all
three is its own change.

### Harness cards

**Settings → Harnesses** draws **one card per harness** - Claude Code, Codex, Pi - each in
the harness's own accent, holding that harness's default **model** and default **effort**
side by side and a sentence restating what a dispatch of that harness will actually do.
While **Auto mode on dispatch** is enabled, cards whose harness can arm its declared
auto-mode posture through launch arguments or an embedded driver show **auto mode on**; an
excluded harness instead shows **no auto mode**, with the reason available on the badge.
The cards derive from the harness list, so a new harness lights up here as one more card
with no layout change and no stylesheet edit. The master toggle sits above them and selects
each supported harness's declared auto-mode posture. Claude's terminal launch carries
`--permission-mode auto`, while its embedded driver applies the same mode directly. Codex's
embedded driver applies **Ask for approval** through app-server; a terminal launch uses
Codex's own widened-sandbox launch treatment instead. Claude's terminal mode is on the
launch argv, not typed in afterwards, so it holds even when a fresh worktree's folder-trust
dialog is still covering the session's mode-line footer.

### Default model

**Each card's model select** sets the model that harness launches on when a
dispatch doesn't name one - one per harness, because a Claude model id is not
something Codex can run. The dispatch form starts on it, so choosing well here is usually
the last time you have to think about models; the per-task picker is for the exceptions.

All three ship as **Harness default**, which means Mission Control passes **no `--model` flag
at all** and the CLI keeps using whatever you configured in the harness itself
(`/model`, `~/.claude/settings.json`, `~/.codex/config.toml`, or
`~/.pi/agent/settings.json`). That's a real setting, not
an empty one - it's how you tell Mission Control to stay out of the way, and you can
always put a card's select back to it.

The default is read **when a task launches**, not when it's created, so changing it also
changes what a task already sitting in the backlog will run on. Like every setting in
this section it applies **only to sessions Mission Control dispatched** - a session you
started yourself and the app merely discovered is never touched.

All three model lists are maintained in `src/shared/model.ts`; a model released after your
build isn't in the picker, but a default set elsewhere (a newer build, or a `PUT` to
`/api/harnesses/config`) still shows and still applies rather than being silently
dropped.

### Default effort

**Each card's effort select** sets the reasoning level that harness starts
with when a dispatch does not name one. Claude Code and Pi
offer `low`, `medium`, `high`, `xhigh`, and `max`; Codex offers `low`, `medium`, `high`,
and `xhigh`.

All three ship as **Harness default**, so Mission Control passes no effort override and the
CLI keeps its own configured choice. Like the model default, this is resolved when the
task launches: changing it applies to already-shelved tasks unless a task selected its
own effort in the dispatch form.

### Session runtime

**Each card's runtime select** chooses how a dispatched session of that harness is *driven*:
in a **Terminal pane**, or embedded on the **Agent SDK**. It ships as Terminal for every
harness, and stays there until you change it - see
[Session runtimes](#session-runtimes-terminal-or-the-agent-sdk) for what turning it on
changes, what it costs, and how to hand a session back to a terminal.

The row renders only for a harness that actually has a driver behind it (Claude and Codex
today); the others say so on the card rather than offering a control that would change
nothing. Like
the model and effort defaults beside it, it is read **when a task launches** and reaches only
the sessions Mission Control dispatches. A stored value this build cannot read, or one naming
a runtime it has no driver for, falls back to Terminal and says so on the card instead of
quietly launching something else.

## Task sources (pulling work into the backlog)

Tasks can be typed into the dispatch form or created through the MCP `create_task` tool.
Meanwhile work already exists somewhere: open issues, a triage board, an on-call queue. A
**task source** reads one of those on a schedule and files what it finds into the
[backlog](#dispatch-an-agent).

**A source files backlog rows and nothing else.** It never dispatches an agent, never cuts
a worktree, never resets a checkout and never types into a session. That is what makes
turning one on a much smaller decision than [Inspector](#inspector-automated-pr-review) or
[Shipping](#shipping-yolo-mode): the worst a broken source can do is put junk in a list you
then read and delete. Auto-dispatching swept work is deliberately **not** a feature - it is
a different risk class, and it would need its own gate (an allowlist, a rate limit, a dry
run) of exactly the kind Foreman carries.

**[Settings](#settings) → Task sources** (the ⚙ gear, or <kbd>⌘</kbd><kbd>,</kbd>) configures
them, as master-detail: a directory summarizing which sources are healthy, awaiting a current
sweep, paused, or need attention, beside the editor for the one you selected. Search it or
filter by health and source type; the metrics strip above counts the whole set either way.
Add one from the inline form above the list by picking a kind and the repo its tasks should
be filed against; it arrives **switched off**, because adding a source is configuration and
turning it on is consent. Per source:

| Control | What it does |
|---|---|
| **Enable** | whether the background loop sweeps it. Off, it still sweeps on demand |
| **Files tasks against** | the repo swept tasks are based on, resolved server-side so a typo can't enter |
| **Sweep every** | how often, clamped to 1 minute - 24 hours. Default 15 minutes |
| **Most tasks per sweep** | hard cap, default 25. What it drops is logged and reported, never silently truncated |
| **What a swept task looks like** | the agent, kind, priority and labels every task from this source carries |
| **Sweep now** | run it once, right now, and see what it filed |
| **Check it works** | is `gh` installed, authenticated, and able to list issues here? |
| **Forget seen items** | make everything this source has filed fileable again |

Pausing clears the source's previous health, so re-enabling it cannot inherit a stale
healthy result. It remains pending until the next sweep; a manual sweep run while paused
already counts as that fresh result.

### GitHub issues

The first (and so far only) kind. **Auth is the `gh` CLI**, run inside the repo, so this
feature stores no token, opens no OAuth flow and adds no new secret - if `gh auth status`
works in that checkout, the source works.

| Filter | Meaning |
|---|---|
| **Repository** | `owner/repo`; blank uses the checkout's own `origin` |
| **Labels (any of)** | match issues carrying **any** of these. Blank matches all |
| **Assignee** | anyone / assigned to me / unassigned. One choice, not two switches - "assigned to me *and* unassigned" selects nothing, so it isn't expressible |
| **Milestone** | restrict to one milestone |
| **Issues per sweep** | how many `gh` is asked for |
| **Copy labels** | put the issue's GitHub labels on the task, case intact |
| **Priority from a label** | map a GitHub label to a [priority](#priority-and-labels), e.g. `P0` → Blocker. The first mapped label the issue carries wins |

Each issue becomes one task: its title, and an intent carrying the issue's **URL and body**,
so the agent's first prompt has the actual text rather than a number to go and look up.

**A broken `gh` never reads as "no issues".** A non-zero exit, unparseable output or an
abandoned sweep is reported as an error on the source and shown in the panel - because an
empty sweep and a broken one are otherwise indistinguishable, and the difference is a week
of silence.

### A task you delete stays deleted

Each source keeps its own ledger of what it has already filed, keyed on the item's id in
the external system. **That ledger outlives the task.** Delete a swept task and the next
sweep does *not* re-file it - otherwise the source would be impossible to say no to, and
Delete would be a snooze button that doesn't even snooze.

The way back is deliberate: **Forget seen items** on that source clears its ledger, and the
next sweep files everything again. Removing a source clears it too, so re-adding one
doesn't leave it permanently silent.

Two things v1 deliberately does not do: it does not **re-sync** an item that changes
upstream (a sweep files new work; it does not reconcile old work, which has to decide what
happens when a human has edited the task since), and it never **writes back** to the
external system.

## Recurring missions

A **recurring mission** is a durable template that files an ordinary backlog task on a
cadence: "audit dependencies every Monday at 8am". It is deliberately not a
[task source](#task-sources-pulling-work-into-the-backlog) - a source reads an *external*
system and dedupes against what it has already seen, where a schedule is internal state
whose identity is the pair `(schedule, instant)`.

Open **Missions** from the topbar button of the same name, beside Dispatch and Sitrep. The
button carries an attention badge when any enabled schedule needs you (a failed run, an
invalid repo, an overdue instant, a stuck reservation - all derived on the daemon, never in
the browser). The catalog is a wide operator overlay, not a settings category, and it owns
Escape like every other overlay; there is **no keyboard shortcut** for it in V1.

The overlay has three screens:

- **Missions** - a rail to search and filter (All / Healthy / Paused / Attention) the live
  list, and beside it one mission's detail: what it does (its name, its cadence as a
  sentence, and the task every run files), its **spine**, and a Configuration disclosure
  holding the exact stored cron, time zone, policies and task defaults. Its actions are
  Pause/Resume, Edit, Archive, and **Run now** (requests a manual occurrence, paused or not;
  it files a backlog task only when the schedule's policies and safety checks allow, and it
  never runs an agent).
- **Create / edit** - a configuration form (not a compose surface) in five groups: the task
  template, the cadence and time zone, laptop availability, overlap and missed-run
  guardrails, and preview-and-enable. Readable presets (daily / weekdays / weekly / monthly)
  and an Advanced cron mode both resolve to the same validated five-field expression. The
  preview rail lists the next 10-50 occurrences with local time, UTC and DST shifts, plus a
  non-mutating standby simulation: give it a sleep window and it shows what the missed-run
  policy would do with every instant that came due while the laptop was off. Two explicit
  buttons: **Save paused** stores the configuration without starting the clock, and **Save &
  enable** re-previews the exact definition before enabling it, so a stale preview can never
  enable changed data.
- **Run history** - the spine on its own, for a generated task's deep link into a mission the
  live catalog no longer lists because it was archived. History survives archive.

### The spine

A mission's detail is arranged around **one time axis**, read downward: what has run, where
nothing did, `NOW`, and what is coming. It is composed from reads that already existed - the
paginated occurrence history (fetched on demand, never polled) and the preview enumeration -
so no new daemon route backs it.

Past occurrences carry their real outcome, delay, trigger and generated task, and expand in
place into the immutable audit of every field the ledger persisted. Future instants are a
quiet ladder of dates with only the next one speaking; DST transitions and collisions with
another enabled mission stay flagged. A **paused, archived or unreadable** mission draws no
future at all - the axis stops with the reason, because showing instants a mission will not
act on is the one thing this surface exists not to do.

A generated-task deep link seeks directly to its occurrence and also loads the newest
history page. When those ranges do not yet meet, the axis shows the unloaded interval and
offers **Load missing history** until the ranges connect. Live missions stay in catalog
detail; only an archived mission uses the standalone history screen. Schedule upserts reset
this history window from the server, so large catch-ups and recovered occurrences cannot
leave stale pagination boundaries behind.

Where an instant sat unclaimed, **the rail breaks**: a dashed segment carrying the real
duration and, inside it, the instants the ledger itself says were folded away. A gap is drawn
from persisted columns only (`scheduled_for`, `claimed_at`, `covered_by_id`); nothing infers
whether the machine was asleep, off, or merely stopped, because the database does not record
which. Small mechanical delays do not break the rail - a break is a much louder claim than a
"late" chip, and it is spent only on a window past every delay the local claim path produces.
Throughout, the schedule's own wall clock is the primary reading and UTC is the audit line
beneath it.

Generated tasks carry their origin across the operator task surfaces: a provenance chip or
compact glyph on the Board backlog card, the Sitrep backlog and recent outcomes, the Dispatch
editor (read-only - the provenance is immutable and never part of a task update), and, once a
task is bound to a session, on the card, the console detail, the board tile, and the rail. The
mark or its tooltip identifies the schedule (by name while it remains in the live catalog,
otherwise by ID) and scheduled time, and every mark deep-links to that run's history.

Under the screens sits the scheduler - a self-rescheduling loop that accounts for every
crossed instant exactly once, applies the missed-run and overlap policies, recovers both
crash windows around task creation, and files backlog tasks and nothing else - and a
validated localhost HTTP surface:

```text
GET  /api/schedules                        the live catalog
POST /api/schedules/preview                enumerate a cadence, writing nothing
POST /api/schedules                        create (save paused or enabled)
POST /api/schedules/:id/update             apply an edit as a new revision
POST /api/schedules/:id/set-enabled        pause or resume
POST /api/schedules/:id/run-now            request a manual occurrence, paused or not
POST /api/schedules/:id/archive            retire it, keeping its history
GET  /api/schedules/:id/occurrences        paginated run history (includes archived schedules)
```

Every mutation is validated by a shared zod schema and preview accepts the exact save
definition, so the browser cannot preview a cadence the save route would refuse. The catalog
is **live over the existing SSE stream** - a top-level `schedules` collection in the
snapshot, plus `schedule_upsert` / `schedule_remove` events - so it never polls; occurrence
history is the one page-oriented read, fetched on demand. Archiving emits a removal from the
live catalog *after* the durable write, and the archived schedule stays reachable through its
history route so a generated task can still deep-link to it. The plan is
[`docs/plans/recurring-missions/plan.md`](docs/plans/recurring-missions/plan.md); a
sleep/wake dogfood checklist is in
[`docs/runbooks/recurring-missions-standby.md`](docs/runbooks/recurring-missions-standby.md).

Three decisions are worth knowing now, because everything later is built on them:

- **A due instant creates a backlog task and stops there.** No schedule path will dispatch,
  cut a worktree, or type into a pane. If [Foreman](#backlog-autopilot-foreman-schedules-the-fleet)
  later picks the task up, the existing allowlist, dependency, capacity and pane-safety
  gates remain the only autonomous route to execution.
- **The guarantee is durable catch-up, not wall-clock.** The cadence lives in SQLite rather
  than in a timer, so a restart or a closed laptop loses no due instant - but no work runs
  while the machine is asleep, and the task is created *late* when it wakes. The catalog
  will show that delay rather than rounding it off. A real wall-clock guarantee needs an
  always-on host, which is a separate project.
- **One hour is the minimum interval, and seconds are not expressible.** Cadences are five
  cron fields; six-field seconds syntax is refused rather than parsed, and an expression
  whose runs come closer than an hour apart is refused with the cadence it would have had.
  A mistyped field should not be able to file 1,440 agent tasks in a day.

Time is calculated in exactly one place, `src/server/schedules/recurrence.ts`, which is the
only consumer of `cron-parser`. DST behaviour is pinned by fixtures against both US
transitions, Europe/London, and a southern-hemisphere zone, so a dependency upgrade that
moves somebody's 2am mission fails the suite instead.

### What the scheduler does when you were away

Every instant the cadence crossed is enumerated from a cursor kept in SQLite, and each one
gets exactly one durable outcome - it never matters how the machine came to be late, only
what the ledger still owes. Which of them create work is the mission's **missed-run
policy**:

| Policy | A fortnight of daily runs becomes |
|---|---|
| **Coalesce to latest** (default) | one task, for the most recent instant; the other thirteen are recorded as `coalesced`, each naming the run that stood in for it |
| **Create all** | one task per instant, capped at the newest 50 per catch-up - the cap bounds *tasks*, not history, so instants past it are still recorded |
| **Skip** | no task; every crossed instant is recorded as skipped |

Then the **overlap policy** asks whether this mission's previous work is still in flight -
a task in `backlog`, `dispatching` or `running`. **Skip if active** (the default) records
`skipped_overlap` and names the task in the way; **Allow** files regardless. A run that
`failed` never blocks: a mission whose last run went wrong still runs tomorrow.

Two more properties, both deliberate:

- **Pausing accrues no debt.** A resumed mission starts from the resume instant, not from
  the one it was parked on, so a month off does not wake up owing thirty runs.
- **A crash cannot lose or duplicate a run.** The reservation and the id of the task it is
  going to create are written in one transaction *before* the task exists, so a daemon that
  dies mid-run either finds the task already filed (and just closes the ledger) or files it
  on the id it reserved. Neither path can produce a second task.

## Multi-agent ensembles

An **ensemble** is a group of ordinary [dispatched tasks](#dispatch-an-agent) run together
under one versioned *strategy*, plus the group-level facts a single task cannot express: one
pinned base commit, member roles, immutable submitted artifacts, evaluations, a human
decision, and a terminal outcome. Three strategies ship: **Best of N** - two to five agents
implement the same task alone from the same commit, one tool-less comparison ranks what they
submitted, and you confirm the winner; **Consensus**, which ends in questions rather than a
winner; and **Panel vote**, the Best-of-N roster judged by independent single-lens judges whose
disagreement is shown rather than averaged away. See [Additional strategies](#additional-strategies)
below and the [operator guide](docs/ensembles.md) for the full strategy, judging, and quorum
semantics.

**Start one from Dispatch, watch it under Workflows.** Open the dispatch modal and flip the
header's launch mode from **Single agent** to **Ensemble** (the modal widens so a candidate
lane holds one line). The same title/repo/intent/attachment compose area serves both; below
it, a descriptor-driven segmented **Strategy** control renders the chosen strategy's own
form - candidate lanes choosing their own agent, model, effort and optional approach hint,
steppers for the tuning knobs, the strategy's judging Persona or panel, and an optional
[workflow](#workflows-and-personas) where the strategy supports one. A **Launch plan** strip
draws what pressing Launch starts - the pinned base, the isolated lanes, the evaluation, and
the human gate - with the estimate figures beside it. **Review launch** sits in the footer's
primary slot and posts a side-effect-free preview (member count, concurrency, waves,
evaluation calls, and whether the chosen workflow mode is executable); once it verifies, a
green **Reviewed** chip appears and **Launch N agents** takes the slot. Any edit after that
invalidates the review, so the launch always confirms exactly what you reviewed. The launch is idempotent on a stable request id: a lost
response and a retry return the same run, never a second fleet. Every candidate wears a distinct
**E** mark (separate from a workflow's **W**) that opens the run and says what the member's own
standing is - `E 3/5 · working`, or an attention-toned **needs an answer** the moment that
candidate is waiting on you. Siblings are drawn *together*: Cards sorts them adjacent, and the
Board and the Console rail group them under a header carrying the run's title, its stage word,
one dot per member of the roster and an **N needs you** rollup - see
[Layout](#layout-cards-console-or-board). The **Ensembles** tab beside Workflows, Personas and
Runs is the monitoring, evidence, decision, recovery and history surface: it wears a badge
counting the runs the daemon marks as needing attention, and lists runs attention-first from the
one live SSE stream with their shared progress dots and `submitted/roster` counts (plus the
launched count while a wave is still opening),
and fetches a selected run's bounded detail - members, immutable artifacts and their on-demand
diffs, the stage/evaluation timeline, the strategy's own result view (Best of N's candidate columns,
Consensus's agreements and divergence cards, Panel vote's rank matrix and ballots), and the decision
that strategy asks for - over HTTP, refetching when that run's summary revises rather than polling.
The strategy-neutral runtime pins one base commit, launches
bounded *waves* of ordinary member tasks (creating every task in a wave before dispatching the
first, and never launching past the concurrency the plan authorizes), accepts an explicit
submission from each member, captures its working tree as an immutable private Git commit, advances
barriers off ready artifacts rather than off a task going idle, and resumes safely after a daemon
restart. A member submits through a dedicated `submit_ensemble_result` MCP tool (with a manual
operator fallback), and the daemon decides *which* member from the calling session, its task and its
worktree - a member never names itself, so a guessed id reaches nothing.

**Best of N evaluation.** When every live member has submitted or terminated and at least two
produced a snapshot, the daemon runs one tool-less, provider-neutral **comparison** of the immutable
submissions and parks the run at a durable human-decision boundary. The judge is deliberately
blind: it is handed the task, bounded base-to-snapshot diffs, per-file statistics and each member's
own reported claims (labelled as claims), but every agent name, model, member ordinal, ref name,
snapshot commit id and worktree path is stripped and each submission is relabelled anonymously, so
brand and order cannot bias the ranking. Truncated diff evidence is disclosed in the result. Every
candidate-authored section is fenced as untrusted data. The reply is validated strictly - exactly
the eligible submissions once each, integer scores, contiguous ranks, a recommendation that holds
rank 1 - and a malformed, incomplete, or injected reply is a *failed attempt*, never a low score or
a fallback winner. The comparison shares the one daemon review-call ceiling with Workflow review,
resolves its runner and model per call (a judging Persona's own overrides, else the
`ensemble-comparison` job model), records every call on a durable ledger, and recovers a call
interrupted by a restart by retrying it against the exact same evidence. It **recommends** a winner;
it cannot promote one.

**The decision is made from a dossier, not from three sections of the page.** When a run parks at
`awaiting_decision` its Result section leads with **At stake** - the run's own intent, the one
commit every candidate started from, the elapsed time and what the fleet has spent (unknown stays
unknown, never `$0.00`) - and then draws one column per candidate composing what that candidate
*reported*, what Mission Control *observed* (diffstat), what it cost, and how it was ranked, with
**Evidence** opening its diff. Panel vote adds a judges x candidates **rank matrix** marking every
cell where a judge broke with the panel, and quotes the ballot that ranked the winner worst in that
judge's own words. The decision form sits at the bottom, after the evidence, and says before the
click that a decision is recorded **once**. Afterwards the dossier persists read-only as the
durable "why we picked B" record - what was promoted, the operator's rationale, and a **Restore**
beside each losing column, which is where the fact that every loser's snapshot was *kept* finally
becomes discoverable. The run's decision is also one click from the
[attention inbox](#attention-inbox-one-place-to-drain-what-needs-you).

**Finalization begins from a durable human decision and nothing else.** You confirm one eligible
submission (or an explicit *no consensus*) through `POST /api/ensembles/:id/actions`; the decision
carries a stable request id, the run state it expects, and an explicit destructive confirmation, so
a lost response returns the same decision and a wrong-state or ineligible pick is refused rather
than acted on. For a selected result, only then does anything destructive run, and it runs
restart-safe in this order:
re-verify the winner's private ref still resolves to its snapshot (a missing ref blocks *all*
cleanup); make one exact winner available - either the original member's checkout reset to the
snapshot through the same session-reset that clears its queue, drafts and context, or, if that
session is gone or busy, exactly one replacement task launched at the snapshot (never two, across
any restart); reap every loser through the normal task cancellation that reclaims its worktree;
reconcile a superseded original winner as described in
[Where the selected result lands](docs/ensembles.md#where-the-selected-result-lands); then either
hand the winner to a workflow or type it one continuation - never both. A step that cannot finish
leaves the run *finalizing* with an actionable error and is resumed by
`resolve_finalization`; the run reaches *completed* only once the winner is exact, every loser is
reconciled, and any workflow submission is captured. Every loser's private snapshot survives.

**The optional Workflow handoff is the N-to-one boundary.** If a run pins a published
[workflow](#workflows-and-personas) version at creation, finalization binds that exact version to
the winning session and submits its clean snapshot through the same server-owned external boundary
any other source uses - idempotent on a stable source key, so a restart returns the same binding
and run. It requires the winner's HEAD to equal the chosen snapshot and its tree to be clean; a
drift is healed by restoring the winner and resuming the *same* submission. A note-key conflict, an
unavailable mode, or a Live/Foreman selection (only Preview is executable today) blocks visibly and
is never downgraded or adopted - you retry after resolving it or explicitly skip the handoff and
finish with the normal continuation. A session cannot be bound to a workflow manually while its
ensemble member is active; finalization marks the selected member retained before it uses the same
binding boundary for the handoff. Ensemble and Workflow lifecycles stay separate: a workflow reset
removes its binding but never an ensemble ref, and a completed ensemble never recreates a reset run.

### Additional strategies

Every strategy runs on the unchanged engine above - the same pinned base, the same member waves,
the same immutable artifacts, the same durable human-decision boundary. What a strategy chooses is
which question its evaluation asks, what the person is asked to decide, and what the terminal
outcome does.

**Consensus** turns three to five independent attempts into *questions instead of a winner*. The
members work exactly as Best-of-N's do; the difference is what happens next. One tool-less,
anonymous, provider-neutral pass compares what the submissions **decided** rather than how good
they are: what all of them did the same way is filed as an **agreement**, and each thing they did
differently becomes an open **question** with one option per position actually taken, attributed to
the attempts that took it. The pass may not rank, score or recommend, and the reply is validated as
strictly as a comparison is - a pass that reported nothing at all, named a submission the packet
never contained, put one submission on two sides of the same question, or silently ignored one of
the attempts is a *failed attempt*, never a question set. Question and option ids are assigned by
the daemon after validation, so your recorded answer names an id no candidate's diff could have
influenced.

You then answer the questions: pick the position you want, or write your own. Nothing is promoted
and **nothing is reaped** - every attempt's snapshot is kept and restorable, the run terminates
*retained*, and the answers are recorded with the decision. The questions you are asked are
persisted when the decision stage opens and your answers are validated against exactly those, so a
re-run evaluation can never turn a recorded answer into an answer to a question you never saw. Use
it when the disagreement is the point - an unfamiliar area, a design with real forks in it, a task
where you want to know what the choices are before you pick one. Its evaluation shares the one
daemon review-call ceiling and the same **Settings → Models → Ensemble evaluation** job as the
Best-of-N comparison.

The public API is one localhost surface: `GET /api/ensembles` (compact summaries),
`POST /api/ensembles/preview` (a side-effect-free launch/budget/handoff estimate that shares
create's exact validation), `POST /api/ensembles` (idempotent create and launch on a stable request
id), `GET /api/ensembles/:id` (bounded detail), `POST /api/ensembles/:id/actions` (one discriminated
action covering decide, resolve-finalization, retry, withdraw, cancel and restore), the bounded
artifact evidence/patch and manual-member-submission routes under that run, and
`DELETE /api/ensembles/:id` (explicit terminal-history-and-ref deletion, confirmed by echoing the
run id, which never deletes a task or linked workflow state and resumes the same remaining refs
after a crash). The dashboard drives all of it from that one surface; on a machine that never
starts an ensemble the tables stay empty and the product behaves exactly as before. The operator
and extension reference is [`docs/ensembles.md`](docs/ensembles.md) (states, private refs,
retention and deletion, costs, restart, recovery, security limits, and how a new strategy composes);
the design plan is
[`docs/plans/best-of-n-swarm-dispatch/plan.md`](docs/plans/best-of-n-swarm-dispatch/plan.md).

<a id="ensemble-strategies"></a>
### Strategies

A strategy is a versioned recipe, not a fork of the runtime: it validates a configuration,
compiles it once into a plan of generic stages, and contributes a result view. Everything below
runs on the same engine, tables, routes and layout marks described above.

**Best of N** (`best_of_n`) - two to five candidates, one comparison, one winner. Described in
full above; it is the default the dispatch modal opens on.

**Panel vote** (`panel_vote`) - the same two-to-five roster, judged by a **panel** of two to five
independent single-lens judges instead of one comparison. The dashboard shows their aggregate,
their individual ballots, and how far their rankings disagreed; at least two usable ballots are
required, and the human still confirms the outcome. The
[ensemble operator guide](docs/ensembles.md#what-panel-vote-does) owns the detailed lens,
aggregation, failure, quorum and recovery contracts.

**Attention and cost are honest.** Ensemble transitions feed the same
[alert engine](#alerts--away-mode) every other "needs you" flows through - a run reaching its
decision, turning unreadable, or stuck finalizing interrupts you; completion, cancellation and
failure land in the Away digest - with no separate notifier. Each candidate's agent cost is summed
from its session telemetry at submission and frozen into its immutable artifact, so the run detail
shows an aggregate attributed per member; a runner that reports no cost is shown as *unreported*,
never `$0.00`, and the evaluator's own model cost and any linked workflow review cost are reported
separately rather than folded in. Hard ceilings no strategy can exceed - 16 members, 8 concurrent, 8
waves, 5 stage attempts - sit above each strategy's own 2-5 candidates, and the preview shows the
exact figures before you launch.

Four decisions are worth knowing now, because everything later is built on them:

- **Every member is an ordinary task.** Ensembles add no second dispatcher, worktree
  provisioner or cancellation path; the group owns what a task cannot own, and nothing else.
  The member link nests inside the task summary a session already carries instead of adding
  another field to the session itself, which is what the **E** mark on every layout reads to
  say which candidate a card is and how the group ranked it.
- **Evaluators recommend; they never promote.** Every evaluation is advisory and runs without
  tools. Anything destructive - resetting a branch to a chosen snapshot, reaping the losing
  worktrees - waits for an explicit human confirmation, and the compiled plan carries that
  requirement as a type the schema will not let a strategy opt out of.
- **A run executes the plan it was created with.** Its strategy, version and compiled plan
  are snapshotted at creation, so a strategy whose defaults change later cannot silently
  re-aim work that is already running. A run written by a *newer* build still loads and
  remains covered by the generic cancel and delete contracts. It reports which piece this
  build does not have and refuses to run rather than substituting something adjacent.
- **Members will not push or open pull requests.** Publishing happens after a winner is
  chosen, through the normal [shipping](#shipping-yolo-mode) flow, so an ensemble never
  leaves N branches and N pull requests behind. Note the isolation between members is
  behavioural, not a sandbox: they share one Git repository and a local agent can find its
  siblings if it goes looking.

Ensembles are deliberately separate from [Workflows](#workflows-and-personas). A workflow
reviews exactly one session; an ensemble is the selection stage over several. They compose
at promotion - a confirmed winner can be handed to a published workflow version - and that
handoff crosses the same server-owned boundary any external result does.

## Attention inbox (one place to drain what needs you)

The topbar's **to answer** count opens the **attention inbox**: one ordered queue holding
everything that is waiting on a person, so nothing depends on catching a toast or noticing a
card. Its sections are fixed and never interleave, because they are different kinds of
obligation:

1. **Decisions** - an ensemble run parked at `awaiting_decision`, with its progress dots and
   **Open dossier**. Nothing else in that run moves until it is answered.
2. **Questions from agents** - every pending [review](#review-channel-mcp), grouped by the
   session that raised it and **answered right here**: the same card the per-session review
   modal draws, diff/plan/question and option menus included. A member of an ensemble carries
   its run context on the header line - *Best of N "Fix the parser" - candidate 3 of 5* - so
   whoever answers can tell they are steering one competitor of a comparison.
3. **Members parked on a menu** - an ensemble member sitting on a terminal
   [option menu](#answer-a-sessions-menu-from-the-dashboard). Listed, not answered: a pane
   dialog is a transient TUI fact answered by keystrokes on the card, and it deep-links there.
4. **Stuck finalizations and shipping gates** - a promotion that stopped on an error, and
   parked no-mistakes gates no agent is driving.

The count is **answers owed**, not rows: a session holding three questions is one row and
three. It is a rendering of state the dashboard already has - it subscribes to nothing, decides
no severity, and is not a second notifier; [Alerts and Away mode](#alerts--away-mode) still own
what interrupts you. Escape closes it, like every overlay. Per-session entry points are
unchanged: a card's review affordance and a board tile's flag still open that session's own
review modal.

## Roundup

Click **Roundup** for a one-look snapshot of every session, assembled from the same live
data the grid shows: **who needs you** (needs-input, pending reviews, parked no-mistakes
gates, sessions sitting on an [option menu](#answer-a-sessions-menu-from-the-dashboard)),
**who's working** (with their intent + activity), **what's idle**, the **backlog**,
and **recent outcomes**. Dispatch a backlog task, [edit it](#edit-a-shelved-task) by
clicking its name, or drop it right from the panel, and **Mark
done** a running task with its outcome (e.g. "opened PR #123") to close the loop. **Copy as
markdown** yields a paste-able digest (also at `GET /api/report.md`; JSON at `GET
/api/report`).

## Alerts & Away mode

So you don't have to watch the grid, the dashboard can **alert you when a session
needs you**. The daemon already streams every attention event over SSE; the browser
turns those into a **desktop (Chrome) notification + a short sound** the moment a
session goes to `needs-input`, a session stops on an
[option menu](#answer-a-sessions-menu-from-the-dashboard) (which needs no hooks, and says
how many options it's offering), a review lands, a no-mistakes gate parks, or a
dispatched task fails. It's zero extra tokens - the daemon (not an LLM) does the
watching - and there's no phone/SMS piece; it's the open dashboard tab that alerts.

**Only things blocked on you ever interrupt.** Informational events (a session going
idle, a task finishing) are detected but never notify; they're digest material. Alerts
fire on the *transition* into attention (once, not every tick) and de-dupe, so a
waiting session pings you once. The chime is synthesized with the Web Audio API (no
asset, no network).

### Stuck sessions

The daemon also watches for sessions that have **gone quiet**, which no state
transition can announce - a stall is defined by nothing happening. Four rules, all
deterministic: an instrumented session that claims to be working but hasn't reported
in ~10 minutes; a session idle ~20 minutes with a task or queue still open against it
(the "died with work unfinished" case); a no-mistakes gate parked with nobody driving
it; and a Foreman escalation nobody answered. A stuck session is attention-level, so
it breaks through even while you're away.

### Away mode

Open the alerts control in the top bar - **🔔** when alerts are on, **🔕** when they're
muted, **🌙** once you're away - to **Enable desktop alerts** (grants the
browser Notification permission and unlocks the chime), toggle **Sound**, and flip
**Away mode**.

While away, anything blocked on you still notifies immediately - everything else
accumulates. When you come back, you get **one card** summarising the window: a couple
of sentences written by Haiku over what actually happened, a deterministic rollup
beneath it ("1 stuck · 3 finished"), and the per-event lines with what needs you
first. Repeats coalesce, so a session that finished twice is one line with a count,
not two notifications. A quiet window produces nothing at all.

Away state lives in the daemon, not the browser, so it survives closing the tab -
which is the case it exists for. The digest is read once; a refresh won't re-announce
it. If the provider is missing or logged out, the narrative is simply absent and the
rollup carries the summary on its own. Which model writes it is
**Settings → [Models](#models-what-the-apps-own-model-work-runs-on) → Away digest**.

## Workflows and Personas

The **Workflows** button in the top bar changes only the dashboard body. The fleet header,
live SSE connection, and Cards, Console, or Board selection stay mounted, so returning to
**Fleet** does not reconnect or discard the fleet view. The page uses bookmarkable hashes:
`#/workflows` for the graph library and builder, `#/workflows/personas` for the Persona
library, `#/workflows/runs` for run history, `#/workflows/runs/:id` for one run's evidence
and timeline, and `#/fleet` to return.
The top-bar button opens the graph library and restores the last active workflow selected
in this browser when it is still available.

A Persona is a reusable Markdown review role, not an agent, terminal session, Foreman rule,
or Inspector setting. Personas you create or import live in Mission Control's SQLite
database. Their name, description, optional provider and model overrides, and guidance are
revisioned together. Saves use compare-and-swap, so a second tab editing an older revision
gets an explicit conflict and keeps its local text. Archive is soft: archived Personas are
read-only, remain addressable for future published history, and continue reserving their
normalized names.

Guidance is exact text. Accepted Markdown is not trimmed or newline-normalized when it is
created or updated. Copy writes that same text to the browser clipboard, download writes it
to a local `.md` Blob, and import stores `File.text()` unchanged after deriving a proposed
name from the first level-one heading or the filename. Download URLs are revoked after the
click. Duplicate creates a new Persona rather than editing the source.

Each saved Persona shows the provider and model its reviews use. Resolution is:
the Persona's provider override or the app-wide provider; then the Persona's model override,
`MISSION_WORKFLOW_PERSONA_MODEL`, or that provider's balanced default. A stored provider id
unknown to an older build is reported and falls back through the shared provider ladder.
Each attempt is a fresh, tool-less provider call. The actual provider and model are recorded
on the attempt so history never has to re-resolve them from current settings.

### Built-in Personas

Four ready-made review roles ship with the application, distilled from the
[no-mistakes](https://github.com/kunchenguid/no-mistakes) pipeline prompts. Nothing has to be
imported: they are in the Personas tab of a fresh install, and any workflow stage can pick
one immediately.

| Persona | What it judges |
|---|---|
| Intent Conformance Judge | Whether the change contradicts a stated acceptance criterion. Fails only on a removed required behavior or an added forbidden one |
| Code Risk Reviewer | Risk the changed code introduces: bugs, security, performance, breaking changes, error handling. Never style, formatting, linting, or types |
| Test Evidence Auditor | Whether the evidence shows the intent working end to end, with visual evidence required for anything a user will see |
| Documentation Steward | Documentation this change made stale, against a one-owner-per-fact placement policy |

They are **app data, not your data**, and the Personas tab marks each one `Built-in`. Each
carries exactly the guidance the build was made from. An upgrade that improves a role updates
the current catalog, so drafts and newly published versions use the new guidance. Existing
published versions keep the guidance they were published with and history marks them
outdated. Adopting the changed guidance requires publishing a new version. Opening a
built-in shows it read-only: Save is disabled, Archive is absent, and there is a line saying
why. **Duplicate** is the way to a version you own - the copy is an ordinary Persona with
its own name, editable, archivable, and never touched by an upgrade. Their guidance is still
exactly as visible as any other: Copy Markdown, Download .md and the preview all work.

Because they always exist, their names are reserved: creating or renaming a Persona to
`Code Risk Reviewer` is refused the way any duplicate name is. The one exception is
historical - a Persona you imported from these documents before they shipped built-in keeps
the name it already reserved, and the built-in it shadows stays hidden behind your copy.
Archive or rename your copy to see the built-in.

The authored Markdown is in this repository under `docs/personas/`, one document per role,
and it is compiled into the build - run `npm run personas` after editing one, and commit the
generated module. Each document's first level-one heading is the Persona's name and the
paragraph under it is the description. **Import .md** shares only the heading-to-name rule;
an imported Persona's description stays empty.

The four are written to compose, and they ship already composed: **No-Mistakes Review** is the
built-in workflow below. Intent Conformance Judge runs first as a cheap gate, then the other
three fan out behind an All-pass Join. None of them restates the engine's own review contract
or output format, which every Persona prompt already carries, so editing your copy changes
what that role judges, not how it replies.

### Built-in workflows

One ready-made review workflow ships with the application: **No-Mistakes Review**, at version
1. There is nothing to author and nothing to import - it is in the Workflows tab of a fresh
install, already published, and can be bound to a session immediately.

It is the four built-in Personas wired the way they were written to compose. Intent
Conformance Judge is stage 1, the cheap gate: there is no point spending three deeper reviews
on a change that has already drifted from what was asked. Code Risk Reviewer, Test Evidence
Auditor and Documentation Steward are stage 2, running **in parallel on the same submission**
and aggregating into one combined repair packet at their All-pass Join. Every fail returns to
the session for repair. A passed review is gated on the
[Inspector final gate](#inspector-final-gate) finding nothing on the pull request:
findings restart the whole review, and a run with no pull request yet offers **Prepare PR in
session** rather than waiting silently. It binds with the ordinary defaults, Manual trigger
and Preview delivery, because Live delivery and Foreman-complete are consent-gated and are
yours to turn on per binding.

Like the built-in Personas it is **app data, not your data**, and the workflow list marks it
`Built-in`. Opening it shows it read-only: it draws in the Pipeline view with every editing
affordance off, Archive and Publish are disabled, the settings rail does not take an edit, and
there is a line saying why. **Duplicate** is the way to a version you own - the copy is an
ordinary workflow with its own name, editable, publishable, archivable, and never touched by
an upgrade. Duplicating changes nothing about the built-in, which stays listed and stays
bindable.

Because it always exists, its name is reserved: creating or renaming a workflow to
`No-Mistakes Review` is refused the way any duplicate name is. The one exception is
historical - a workflow you authored under that name before it shipped built-in keeps the name
it already reserved, and the built-in it shadows stays hidden behind your copy while remaining
addressable, so bindings and runs pinned to it keep resolving. Archive or rename your copy to
see the built-in.

An upgrade that improves one of the four Personas improves this workflow too, with no gesture
from you: it always carries the guidance and the graph the build was made from. Improving the
shipped workflow itself appends a **new version** rather than editing the one you may be bound
to, so an existing binding keeps running exactly the graph it was bound to until you rebind it.

The graph is not stored in your database at all, which is what makes all of that true without
a seeding step that could half-run. It is compiled into the build beside the Persona documents.

### Workflow drafts and published versions

A workflow is **stages of reviewers**, and the **Pipeline** view is where you author one.
It draws Session, the stages between it, and the End outcome; you add, remove and reorder
reviewers and stages, and everything structural is generated for you. A stage holding two or
more reviewers gets its all-pass Join, every fail returns to Session for repair, and the last
stage's pass reaches End. Nothing is hand-drawn, so none of it can be got wrong.

A brand-new workflow opens on Session, one empty stage affordance, and End - opening it never
edits it. Picking a Persona from the stage's inline list makes it stage 1; picking a second
makes the two run **in parallel on the same submission**, both of which must pass before
anything moves on. That is the whole gesture: two picks, no validation error. A version
published with that shape runs correctly on any build, but an older build refuses to
re-publish it.

Reorder by dragging a reviewer onto another slot or another stage, or from the keyboard:
arrow keys move between cards, <kbd>⌥</kbd> plus <kbd>←</kbd> / <kbd>→</kbd> moves the focused
stage along the chain, <kbd>⌥</kbd> plus <kbd>↑</kbd> / <kbd>↓</kbd> moves the focused reviewer
within its stage, and <kbd>Delete</kbd> removes the focused card after a confirmation.
Announcements and labels name Personas and stages; no surface prints a node id. A stage's name
is derived, not stored: one reviewer names its own stage, and a parallel stage reads "Stage N".

**Graph** is the other half of the toolbar toggle, and it still edits anything. Add Persona,
**All-pass Join**, **Check** and End nodes from the left palette, then connect the directional
handles: Session emits `submitted`; a Persona, Check or Join emits `pass` and `fail`; failures
may return to Session for changes. Session needs at least one `submitted` route and may fan
out to several. A Join needs both outcomes from at least two distinct predecessors, waits for
one result from each, and passes only when all passed; a predecessor may be a Persona, a Check
or another Join. Cycles are legal only when they include Session. Persona-only cycles are
rejected because they could spend repeatedly against unchanged work. There is no checkpoint
node and Inspector is not a graph node.

The Pipeline view is offered exactly when a draft *is* a pipeline: one Session, a linear chain
of stages, one End, and nothing else. A graph drawn freehand that is not - two End nodes, a
fail routed somewhere other than Session, a Join fed from two different stages - opens in
Graph with a banner naming each reason in a sentence. A graph containing a Check node also
opens in Graph, with a banner saying so; the Pipeline editor cannot show one yet. Both views
write ordinary draft graphs, so a draft moves between them freely and existing workflows need
no migration.

### Check nodes (gating on a command)

A **Check** represents a deterministic command gate instead of a model review. This build
ships the graph node, configuration, validation, and run-detail contract, but not the
crash-safe execution runtime: **it does not spawn configured check commands yet**. An
authorized, configured Check is recorded as **Not run** and passes with a note explaining
that the runtime is unavailable. Command execution is a separate implementation unit because
it must run against a pooled worktree pinned to the captured commit and recover its process
and lease safely after a daemon crash.

**A Check names a slot, never a command.** The slots are `test`, `lint`, `typecheck` and
`build`. The command assigned to each slot is configured per repository under **Settings →
Workflows**, keeping the exportable published version machine-neutral and free of argv. The
execution contract accepts an **argv**, not a shell string, so `&&`, `|` and `$HOME` are
ordinary arguments. The settings field splits a typed line quote-aware (`'…'` literal, `"…"`
honouring `\"` and `\\`, a backslash escaping the next character outside quotes, adjacent
runs joining into one token) and **shows the parsed argv back**, so you see what the
execution runtime will receive.

Each repository may configure a slot **once**; a second entry for the same pair is refused
rather than silently ignored. A **subdirectory** entry beats the repository-wide one, which
is how a monorepo gives one package its own command - and the command then runs *in that
subdirectory*, not at the top of the tree. Worktrees of a configured repository count too,
wherever they live on disk: a dispatched session usually stands in a pooled checkout under
`~/.treehouse/`, and because a worktree mirrors its repository's layout, a session in that
checkout's `packages/web` resolves the command configured for the repository's
`packages/web`. That match is on the exact directory, component by component - a session in
`examples/packages/web` gets the repository-wide command, not the one configured for
`packages/web`.

**An unrun gate passes, with a note saying why.** A slot with no command configured for this
repository is *skipped*; a repository that has not been authorized is *not run*. Both pass,
because a workflow that failed on every unconfigured machine would be broken by default, and
both say which of the two happened so it is never mistaken for a gate that ran. In this build,
the missing execution runtime is a third *not run* outcome that also passes with its own note.

**Checks are consent-gated twice**, and are off by default. **Settings → Workflows**
(`#/settings/workflows`) carries both controls: **Enable workflow check commands**, the switch,
and **Check commands**, the table of repository root, slot and argv. The switch alone is not
enough - the repository must also be on the same Workflow allowlist Live delivery uses.
Enabling it authorizes running code the reviewed branch supplies - its scripts, dependencies
and build steps - with the daemon's own filesystem authority. This is not a sandbox. Checks run
through their own small attempt budget, separate from the review budget; enabling consent does
not override this build's missing execution runtime.

Run detail draws a check as its own card. In this build it shows the slot, configured argv,
and the reason the command was skipped or not run.

Draft changes autosave after 500 ms of quiet. Every write carries the revision it loaded,
so a newer tab cannot be overwritten: autosave pauses and offers **Reload latest** or
**Duplicate my draft**. A conflicted draft cannot be replaced by selecting or creating
another workflow; Duplicate is the explicit path that preserves it under a unique name.
Validation runs from the same browser-safe implementation in the
canvas and at the daemon boundary. It checks ports, routes, Join pairs, reachability,
Session-centered cycles, active Personas, graph limits, and finite bounded coordinates.

**Publish** is enabled only for a saved, conflict-free, valid revision. It is idempotent for
that revision and creates an immutable version containing the exact name, description,
Markdown, provider/model overrides, and revision of every Persona. Editing or archiving a
Persona you own, or updating a shipped built-in in a later build, never changes old versions;
history marks its snapshot as outdated or its source as archived. To update a published
design, edit the mutable draft and publish a new version. Opening a workflow fetches only
bounded version metadata; selecting one history entry fetches that immutable graph and its
exact Persona Markdown from the version route.

Workflow settings also store binding defaults: Manual or Foreman-complete trigger, Preview
or Live delivery, and a repair-round limit. Manual plus Preview remains the default. The
optional Inspector final gate and its missing-PR and findings policies are immutable parts of
each published version.

### Retiring a workflow

**Archive** is the way to retire a published workflow, and it is soft and reversible.
Archived workflows leave the default library listing and refuse edits, new bindings, and
binding reattachment until restored. Existing bindings and in-flight runs remain intact,
and published versions and run history stay readable. Archiving is refused while any binding
on the workflow is still active. **Restore** brings one back: the normalized name was never
released while archived, so nothing can have taken it and there is no conflict to resolve.
Show archived workflows with the checkbox under the library list.

**Delete** is offered only for a workflow that has never been published, and it removes the
row outright. That restriction is what makes it safe rather than careful. A binding names a
published version and a run names a binding, so a workflow with no versions can have no
binding, no run, and none of the submissions, attempts, deliveries or evidence hanging off
one; there is nothing to orphan and nothing to cascade. Publish once and the workflow can
only ever be archived, because an immutable version is audit history that bindings, runs and
ensemble handoffs quote by id. Deleting also frees the name for reuse, which archiving does
not. Delete asks for confirmation and cannot be undone.

### Manual Preview runs

Bind a session to an exact published workflow version from the workflow history or from any
fleet layout, then choose **Preview**. A binding records the conversation note key, harness,
name, working directory, and repository root, and pins the immutable version id. Publishing or
editing a newer workflow cannot change an existing binding or run.

Each submit and resubmit carries a durable request key. The daemon creates the submission
before evidence capture, so retrying the same request returns the same durable row and never
starts duplicate work. One submission captures one shared snapshot for every concurrent
Persona. It preserves the raw goal, refined goal when present, human decisions and rationale,
repository HEAD and diff, transcript evidence, repository standards, and prior Persona
feedback. A cheap provider-neutral compaction call may summarize that context, but its
45-second attempt cannot replace the raw evidence. An unparsable reply gets one fresh
45-second attempt; invalid, timed-out, or unavailable compaction produces a deterministic
visible fallback.

Persona prompts put the operator's intent, decisions, constraints, and acceptance criteria
before repository evidence. Prior Persona feedback is labeled as non-human input and all
captured evidence is fenced as untrusted data. A strict `pass` verdict requires approval
details; a strict `fail` verdict requires concrete requested changes and evidence references.
Malformed output, provider failures, and timeouts are infrastructure errors, never Persona
fail verdicts.

The durable engine records attempts and edge receipts, waits for all inputs at an all-pass
Join, retries transient infrastructure failures with bounded backoff, and stops at the
binding's repair-round limit. A failing path back to Session waits for a manual resubmit.
Resubmission captures fresh evidence and refuses an unchanged snapshot unless the operator
explicitly confirms it, so an approval from an older round is never reused. Preview performs
no terminal write, keystroke injection, Foreman action, Inspector action, or message delivery.

The whole daemon runs at most three review calls at once, and Persona attempts and context
compaction spend that one budget together rather than each holding a private ceiling. The
Foreman is a separate process with its own serial queue, and the background jobs below keep
their own limits, because they degrade differently and must not wait behind a Persona call.

Run state survives daemon restarts. Interrupted provider calls become auditable errors and
are retried without duplicating receipts; missing immutable data fails visibly instead of
falling back to a mutable draft. A disappearing session orphans its binding. A conversation
clear pauses it. Reattachment is explicit and validates the harness and repository identity,
then requires a fresh resubmit. Reset removes bindings, runs, submissions, attempts, receipts,
captured context, and model-call metadata through the same session reset owner. Compact run
summaries update over the existing SSE stream, while detailed evidence and timelines are
loaded only for the selected run. Cards, Console, and Board show the same workflow status.

### Watching a run

The **Runs** tab reads a run on **the pipeline it was authored on** - the same Session,
stages and End the Pipeline view draws, with a live status on every reviewer: queued,
reviewing, passed, or changes requested. A stage of two reviewers shows both and passes only
when both do. A version drawn freehand in the Graph view is not a pipeline, so its run falls
back to that graph, read-only, carrying the same statuses. No surface prints a node id.

The rail lists history newest first with a state chip, the bound conversation and a relative
time. Four chips - **All**, **Running**, **Needs you**, **Done** - are shortcuts onto the
same single-state filter the **State** dropdown offers in full; the dropdown still reaches
every state, and workflow id and session filters sit beside it. Filters and the selected run
are part of the bookmarkable hash, and history pages 50 rows at a time.

A run is read one **round** at a time. The scrubber lists every submission with the round it
is - Inspector-only repair rounds marked as such - and the round that asked for changes is
marked even though its submission is a healthy `waiting for the session`. Selecting a round
scopes the pipeline statuses, the verdicts, the join packets and the timeline to it; the
latest round is selected by default. The Inspector gate, completion claims, deliveries and
every recovery action always reflect the live run whatever round is on screen, and a note
says so while an earlier one is selected.

Verdicts are cards: the outcome, the reviewer, its summary, its approval rationale or
requested changes with evidence references, and the runner, model, duration and cost that
actually ran. Inspector gate state, Foreman completion claims and repair deliveries are the
same card with a different accent. Durable failures read as sentences - "The write may or may
not have landed" - with the machine code kept beside them for a bug report, never instead of
them. The timeline names Personas and rounds rather than printing payload JSON; **Export
run** remains the complete durable record.

Actions that cannot be taken back confirm in the app rather than in a browser dialog.
**Cancel run**, the resubmission against unchanged evidence, and the delivery's **Mark
delivered** ask once; **Restart full workflow** and **Discard and send new round** require
the exact phrase the daemon also demands, typed into the confirm.

With no runs at all the tab offers **Bind to a session…**, the same dialog the builder's
right rail opens.

### Runs Mission Control started for itself

Almost every run is one an operator submitted. A run can also be started by Mission Control
on its own behalf, when one of its own features has already selected an exact result and
wants it reviewed. That path is internal - there is no endpoint that starts arbitrary runs on
a caller's say-so, and nothing can aim one at a session you did not choose. The daemon
resolves the published version, the live conversation, and the idempotency key itself.

Such a run is one run. Repeating the request, or restarting the daemon mid-flight, returns
the same binding, the same run, and the same first submission rather than starting a second
review of the same work. A conversation that already has an active binding is reported as a
conflict: yours is never replaced or quietly taken over.

The evidence must be exactly what was selected. Before anything is stored and before a single
provider token is spent, the capture has to observe the expected commit **and** a clean
working tree - matching HEAD with uncommitted changes beside it is not the selected result.
A mismatch blocks visibly and says what it saw; restoring the exact result and asking again
resumes that same submission instead of opening a new round.

That commit is pinned to the run at creation and cannot be changed afterwards. A repeat call
naming a different commit is refused rather than accepted, so one result id always means one
artifact. For the same reason the ordinary **Preview fresh evidence** and discard-and-resend
actions refuse on these runs: they re-read whatever the session holds right now, which is not
what this run is reviewing.

These runs are Preview and Manual only for now. If the pinned workflow version's defaults ask
for Live delivery or Foreman completion, the request is refused rather than quietly downgraded
to Preview - being handed a review that silently never reaches the session would be worse than
being told no.

Run detail names the feature that started a run, matched on that run's own source, so an
ordinary manual run on the same session is never labelled as someone else's. Reset removes the
claim with the rest of the run family.

### Live repair delivery and Foreman completion

Live workflow delivery is separately off by default. Open **Settings → Workflows**
(`#/settings/workflows`), enable Live after its explicit warning, and add canonical repository
roots to the Workflow allowlist. A Live binding can be saved only while its current session is in an allowlisted
checkout. Removing consent keeps the binding choice visible but refuses the next delivery;
it is never silently changed to Preview. The same panel holds the second, independent switch
for [Check nodes](#check-nodes-gating-on-a-command), which shares that allowlist and grants
something different: running branch-authored code, not typing into a pane.

When a Persona failure returns to Session, the daemon renders one bounded deterministic repair
packet in published graph order. The packet preserves the original raw goal, identifies the
immutable workflow version and evidence fingerprint, and includes only failed Persona findings.
Preview stores the exact packet and hash without touching the terminal. Live records
**Prepared**, claims **Sending**, and uses the same pane-locked prompt injection as dispatch and
the work queue. Confirmed delivery is credited to `workflow` in the transcript. A positive
pre-write refusal can be retried explicitly; a lost or possibly-landed write becomes
**Delivery uncertain** and is never sent again automatically. Inspect the pane, then either
mark it delivered or type the required confirmation to discard it and create a new repair
round.

**Foreman complete** lets an active binding claim Foreman's existing queue-drain or prompted
completion proof. Foreman still runs as a separate HTTP-only worker and never reads workflow
SQLite. The daemon creates or resumes the durable workflow and retires the matching Foreman
once-only guard in one transaction. A missing or failed claim endpoint fails closed - Foreman
does not fall through to an unreviewed wrap-up. If no Foreman binding claims the boundary,
the existing wrap-up behavior is unchanged. After one confirmed Live repair, a queue-backed
session's drain guard is re-armed once; itemless sessions re-arm naturally when the delivered
repair becomes the new captured goal.

### Inspector final gate

An Inspector completion policy adds a final stage after a successful End. End stays successful,
but the run does not complete until Inspector has reviewed the exact PR head represented by that
submission. A PR URL on the session is only a lookup hint. The gate can use it only when the
durable Inspector ledger already says the hook saw `gh pr create` or no-mistakes reported its own
PR. A URL alone never adopts a pull request and never grants permission to comment on it.

Gate entry records the local committed HEAD, then waits for a normal Inspector sweep observed
after entry. It does not start a second GitHub poller. The observed PR must still be open, its
remote head must equal that captured HEAD, and the captured working tree must have no staged,
unstaged, or untracked changes outside the commit. A dirty tree requires commit, push, and a fresh
full submission. A pre-pin mismatch waits for Inspector to observe the captured committed head; a
push after pinning requires a fresh full submission. A stale ledger timestamp or reviewed head
alone, including one loaded after a daemon restart, cannot satisfy the gate; the next normal
Inspector observation must first prove which head is current.

Once the matching head is pinned, the durable Inspector ledger decides the state:

- A pending, failed, or backed-off review remains waiting and shows its current posture and retry.
- Every non-resolved Inspector row remains a finding, including dry-run drafts and interrupted
  posting rows. Run detail shows its stored scrubbed body, or an explicit fallback for legacy rows.
- A completed current-head review with zero findings completes the workflow.
- Closing or switching the PR blocks instead of accepting old approval.

Findings produce one frozen, bounded, hashed `inspector_feedback` packet through the same Preview
or safe Live delivery state machine as Persona repair. The published default,
`restart_workflow`, requires fix, verify, commit, push, and a full resubmission that reruns every
Persona. The narrower `inspector_only` policy waits for Inspector to observe a different pushed
head, records an immutable attempt-free bypass submission, and reviews that head normally. It
refuses the failed head, every prior repair head, PR switching, and the round cap. Run detail
labels the Persona bypass and offers an explicit confirmed restart of the full workflow.

If no adopted PR exists, the published policy either waits or offers **Prepare PR in session**. That
human action sends a deterministic commit, push, and PR prompt through Preview or Live delivery;
the gate itself never pushes or opens a pull request. **Recheck Inspector** only reevaluates the
current durable observation and remains waiting until Inspector's normal sweep has seen a new
head.

Gate summaries travel on the existing workflow-run SSE upsert. Finding bodies and full audit
state stay on the selected run's HTTP detail, so the browser adds no polling. Reset removes the
session-bound workflow gate, submissions, packets, and events, but retains Inspector's adopted PR
and comment ledgers because those records outlive a session.

### Retention, history, exports, and workflow health

Workflow retention is configured under **Settings → Workflows**. It has two stages:

1. Raw evidence is compacted from eligible completed or cancelled runs after 30 days by default.
   The diff, transcript, status paths, standards bodies, and delivered or refused packet text are
   removed. Their hashes, counts, truncation flags, HEAD, branch, timestamps, goals, decisions,
   compacted constraints, immutable Persona snapshots, verdicts, Inspector fingerprints,
   delivery state, event history, and model-call records remain.
2. A complete eligible run family can be removed after 180 days, but only when it is also outside
   the newest 1,000 completed or cancelled runs.

The settings allow 1–365 raw-evidence days, 30–3,650 completed-run days, and a newest-run cap of
100–10,000. Shortening any boundary requires confirmation. Active, waiting, blocked, failed,
orphaned, and delivery-uncertain work is never age-pruned. In particular, an uncertain delivery
keeps its exact payload until a human resolves it. The daemon runs one non-overlapping sweep after
workflow recovery and then hourly. A sweep failure stops only that sweep and appears in Workflow
health; it never stops execution or delivery.

The panel shows those limits **against a measurement**: how many finished runs the newest-kept
cap actually ranks, and what the last sweep compacted and deleted (or that no sweep has run
yet). That figure counts only the population the cap windows - completed or cancelled, with a
completion time, and not pinned by an uncertain delivery - so it is comparable with the limit
beside it. It is deliberately not the **Retained runs** counter under Workflow health, which
counts every run row of any status and therefore climbs on active work no retention limit can
remove.

Run history is loaded 50 rows at a time and can be filtered by state, workflow id, or session.
Filters are part of the bookmarkable hash. A selected run stays selected as SSE updates arrive.
Events and workflow-owned model calls load in pages of at most 200 durable records. Raw run and
immutable version exports are versioned JSON downloads from the Run detail. A retained run export
marks pruned evidence explicitly, so an empty diff is never confused with a review that saw no
diff.

Workflow-owned model calls record the actual runner, model, attempt, state, timing, input bytes,
output bytes, retry, and classified error. The local runner returns text but no authoritative
price, so the monetary field remains `null` and the UI says **Cost unavailable from this runner**.
It is never displayed as zero, inferred from the fleet ledger, or estimated.

Workflow health is read under **Settings → Workflows**, and refreshes on its own while that
panel is open. It reports active runs, queued and running Persona calls, waiting, uncertain and
delivered deliveries among retained run families, Inspector gates, retained run count, recovery
time, retention time, the last retention error code, and the last compacted and deleted counts.
It contains no prompt, diff, transcript, Persona guidance, model output, or delivery payload.

Five of those counters lead as a **strip of tiles, in escalation order** - *Needs you*
(uncertain deliveries), *Waiting*, *Inspector gates*, *Active*, *Delivered* - and each tile
opens the nearest corresponding view in the
[run list](#workflow-drafts-and-published-versions), applying a status filter where one exists.
*Active* counts every run that has not finished - running, waiting and blocked alike - so it
deliberately carries no status filter: no single run status means "active", and one would
exclude rows the tile had just counted.
The rest stay as a plain list beneath it: they are throughput and sweep bookkeeping, and
rendering them in the same weight as "a repair may or may not have been typed into somebody's
session" was what made the one counter that needs a human the least findable thing on the
panel. **Delivered** is the fleet-wide count of deliveries confirmed typed into a session
among run families retention still keeps. Compaction does not reduce it, because a compacted
delivery keeps its state and loses only its content. Full run-family deletion does reduce it:
once a finished family is older than `completedRunDays`, outside the newest
`maxCompletedRuns`, and not pinned by an uncertain delivery, retention deletes its delivery
rows too.

For an offline backup, stop Mission Control and copy
`$MISSION_HOME/harness.db` (by default `~/.mission-control/harness.db`) together with its `-wal`
and `-shm` files when present. Run and version exports are portable audit artifacts, not a database
restore format. Restore the SQLite files only into a stopped daemon using the same or a newer
Mission Control build.

### Canvas and accessibility controls

Palette buttons add a node at the current viewport center; pointer drag remains available.
The canvas snaps to its visible grid and includes zoom in, zoom out, fit, 100% reset, and a
pannable minimap. **Auto-layout** changes positions only, then fits once. Local draft undo and redo
hold the last 50 meaningful edits and use <kbd>⌘/Ctrl</kbd><kbd>Z</kbd> and
<kbd>⌘/Ctrl</kbd><kbd>Shift</kbd><kbd>Z</kbd>. Autosave does not consume history entries.
Duplicate applies to Persona, Check, Join, and End nodes, never Session.

Tab enters the graph through one roving node focus. Selected nodes move one grid unit with an Arrow
key and ten grid units with Shift+Arrow. Press <kbd>C</kbd> on one selected non-terminal node, or choose
**Connect…**, to open the keyboard connection form; it uses the same port validator as pointer
connections. Delete or Backspace shows the number of selected nodes and connected edges before
removal. Every edge is also focusable and removable in the Properties drawer. Port names appear
on hover and focus, failure paths are dashed and text-labelled, state changes use live regions,
focus returns after dialogs, and reduced-motion preferences disable canvas and panel animation.
At narrow widths the canvas stays primary and Library and Properties become mutually exclusive
drawers.

## Models (what the app's own model work runs on)

Mission Control does a little model work of its own - naming an untitled
[dispatch](#dispatch-an-agent), rewriting a prompt into the [Goal](#goal) on a card, narrating the
[away digest](#away-mode), compacting Workflow evidence, and evaluating Ensemble submissions. None
of it is the agent in a card, and none of it should have to be: **Settings → Models** is where you
say which provider does that work and which model each job uses.

Two separate choices, deliberately.

**The provider** is app-wide - it answers *how* a model is called, not which one. Two ship: the
local `claude` CLI (the default) and `codex exec`. Either way there is no API key anywhere in this
path - each bills through whatever its own CLI is logged in as. It is entirely
independent of which harness a card runs, which is the point - you can review a Codex session with
Claude, or run the cheap jobs on the account that has quota left. Picking a provider clears the
model boxes below it, because a `claude` model id is not something `codex` can resolve.

**The model** is per job:

| Job | Default | Env | What it does |
|---|---|---|---|
| Task title | `claude-haiku-4-5` | `MISSION_TASK_TITLE_MODEL` | Names a dispatched task whose Title was left blank, for the card and the branch |
| Goal | `claude-haiku-4-5` | `MISSION_GOAL_MODEL` | Rewrites each session's raw prompt into the sentence its card shows |
| Away digest | `claude-haiku-4-5` | `MISSION_AWAY_DIGEST_MODEL` | Narrates what the fleet did while you were away, over the deterministic rollup |
| Workflow context | `claude-haiku-4-5` | `MISSION_WORKFLOW_CONTEXT_MODEL` | Compacts Preview evidence without replacing its preserved raw goal, decisions, and rationale |
| Ensemble evaluation | `claude-haiku-4-5` | `MISSION_ENSEMBLE_COMPARISON_MODEL` | Ranks Best-of-N candidates, mines a Consensus run's divergences, or scores one Panel-vote ballot per judge, all tool-less. A judging Persona's own model wins over this |

Each resolves the same way [Foreman's four](#which-model-foreman-runs-as) and the
[Inspector's one](#the-review-model) do: **your setting, then the environment variable, then the
shipped default**. Clearing a field means "fall back", never "run with no model" - an unset
`--model` inherits whatever the CLI happens to default to, which is the priciest tier available
and is not recorded anywhere. The panel prints which of the three won, because an environment
variable set in the daemon's shell outranks the box and would otherwise be invisible from the
browser. Any id the selected provider's CLI accepts works; the fields are free text, not a fixed
list, with suggestions offered for whichever provider is in force.

The title, goal, digest, and Workflow-context jobs are best-effort calls with a deterministic
fallback, so a missing or logged-out provider degrades their output rather than failing a
dispatch. An Ensemble evaluation is different: a provider failure or invalid reply fails its
durable, bounded attempt, and the engine never invents a recommendation or a question set.

**Foreman's four models and the Inspector's review model are not here.** They live with the
subsystem that spends them - **Settings → Foreman** and **Settings → Inspector** - because each
panel owns the config it writes.

## Foreman (auto-responder)

The dashboard tells you *who needs you*; **Foreman** can start draining that queue for
you. It's an optional agent that watches the `needs-you` bucket and, for each blocked
Claude Code session or Mission Control-launched Codex session that has reported a hook,
reads the transcript to understand the goal **and the session's terminal screen to see
the ask itself**. A parked no-mistakes gate is the narrow exception to that hook boundary:
the daemon observes and attributes the gate independently, so Foreman can review it for an
operator-started Codex session without enabling automation for that session's ordinary menus,
questions, work queue, or wrap-up. Foreman then:

- **auto-answers** the routine calls - implementation trade-offs (defaulting to the most
  correct, secure, non-duplicative option) and non-destructive access requests;
- **escalates** the genuine forks - a call that hinges on your intent, or anything
  destructive/risky - as a framed **decision brief** with its recommendation, and pings you;
- **stands in for you at a parked [no-mistakes](#no-mistakes) gate** - when a run stops to put
  an `ask-user` finding to you, Foreman reads the finding and the session's goal, answers when
  the call is clear from that goal, and escalates when it turns on your intent;
- writes a 1-2 sentence **Purpose** on every session it inspects - the recent context
  bearing on *this* decision, shown in the expanded card. It reads the session's
  [Goal](#goal) rather than re-deriving it, so the two don't say the same thing twice.

The screen matters more than it sounds: a prompt that is *waiting on you* - a menu, a
permission dialog - isn't written to the transcript until it returns, so the transcript
routinely ends **before** the very question Foreman is there to answer. Reading the pane is
what lets it answer the ask rather than hand it back to you having only read the history.

The screen is also *how* a menu gets answered. A dialog isn't a text box: it discards typed
characters, and the Enter that follows them confirms whichever row was already highlighted -
the default, not the reply. So Foreman answers a menu the way you would, by walking the
cursor onto the row it picked and pressing Enter only while the pane still shows that row
selected. An answer it can't pin to a row on screen is **escalated to you** - with its
reasoning kept as the recommendation - rather than typed at a menu that would discard it.
You get the same affordance for the same reason: a menu on any session is offered to you as
[clickable rows](#answer-a-sessions-menu-from-the-dashboard) too, and whichever of you
reaches it second is refused rather than pressing the wrong row. Because a visible menu puts
a session in `needs-you` on its own, Foreman can pick up a Claude session parked on one that
no hook has reported yet: Claude's hooks are machine-scoped, so the visible menu supplies the
missing state without crossing a launch boundary. That gap is real and measurable: Claude
reports `AskUserQuestion` as *work in progress* when the menu opens and only says it is
waiting for you about six seconds later, so an ask caught in between used to be handed
straight back to you as "no reply channel", with an answer Foreman had already written. The
menu's own rows identify the ask, so one question costs one review however the hooks land.
Codex hooks are launch-scoped instead: an operator-started Codex menu remains available as
clickable rows for you, but is explicitly excluded from Foreman automation.

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

Live sending is gated by an explicit **repo allowlist**, granted in
**Settings → [Trust](#trust-who-may-act-in-which-repository)** (the Foreman panel shows the
count and links there). With an empty allowlist Foreman never types into any live session. In
Live mode the popover shows a read-only **Live in N repos · manage in Settings →** link
straight to it. An entry allowlists the **repo**, not just the directory: a session in a
*worktree* of an allowlisted repo is cleared too, wherever that worktree sits on disk.
That's what makes live mode usable - dispatched agents and treehouse checkouts run in
worktrees parked far from the repo, so a directory-only rule would draft forever on the
very repo you cleared.
A worktree of a repo you haven't allowlisted is still refused. A separate
**Auto-approve non-destructive access** switch (on by default) governs whether it may
approve access/permission asks - turn it off and those escalate to you instead.
Destructive or risky asks (force-push, secret access, prod deploy, data drops, disabling a
safety check) are **always** escalated, never auto-approved.

Everything Foreman does surfaces where you're already looking. On a **card**: a needs-you
session it acted on shows a
**◆ decision** flag (or **✎ draft**) in its header, the expanded card shows the decision
brief + recommended answer with **Approve & send / Dismiss** controls, and an answered
session carries a `✓ Foreman answered: …` audit line. An escalation also fires a browser
**alert**. The top-bar chip shows the mode, whether the worker is running, and the queue
depth.

In the [Console and Board](#layout-cards-console-or-board) detail the same decision is
arranged differently, because a permanent conversation gives it somewhere better to sit:
Foreman's note is rendered **in the transcript**, as a turn at the point it spoke, and what
you still *owe* is a one-line strip above it - badge, disposition, purpose, **Approve &
send** - that expands for the recommendation and **Dismiss**. It can't cover the chat,
because the prose isn't in it. The strip unmounts once the note is answered or dismissed;
the inline entry stays.

**Approve & send** appears only where there is somewhere to send it. A note whose question
has since been resolved elsewhere, or one Foreman escalated *because* it had no reply channel,
offers **Dismiss** and says which of the two it is - the alternative was a button that
silently closed the note, which reads as having sent something. Foreman also re-checks the
session before pinning a decision at all: a review takes up to a few minutes, and if the
session moved on in that time the decision is filed in the **Foreman · N** history instead of
waiting for a click on a question that has already closed.

Every decision is also **kept**, which the note alone never was - a note is one upserted row,
so each write erased the last one and approving erased the words that had just been sent.
Foreman now records each decision it faces: the question the session was blocked on, what it
concluded, and what actually went back. That question is the part worth recording - for a
terminal ask (a permission prompt, a menu) the child's screen is the only place it ever
exists, per the transcript gap above. The **Foreman · N** rail at the end of the detail's tab
row opens that history: rows lead with the *ask* rather than the verdict, and opening one
shows the ask verbatim beside Foreman's reasoning and the resolution, credited to whoever
actually made the call. Records age out after a retention window.

Only one worker drives the sessions at a time. `npm run foreman` twice is safe: the second
process acquires no **lease** and idles as a standby, taking over automatically if the
leader dies. That matters because two workers would double-answer a prompt - or, with work
queues below, type the same work instruction into a live agent twice.

### Its standing instructions (`FOREMAN.md`)

Foreman ships with a built-in judgment policy, which is deliberately generic. Beside it sits a
second, editable half: **standing instructions** written in plain prose, telling it how *you*
want these calls made. They are read into every review, every work-item verification, **and the
[cheap tier](#the-cheap-tier)** - that last one matters, because the cheap tier answers routine
permission asks on its own and never escalates them, so instructions it couldn't see would be
silently skipped on the highest-volume path in the system.

The defaults ship as [`FOREMAN.md`](FOREMAN.md) at the app root - ordinary markdown you can read
and edit. Write what you would say if you were looking over its shoulder:

```markdown
## What I care about, in order
1. Correctness, then simplicity, then maintainability. Development cost is nearly last.
2. One abstraction over N special cases. If the options all amount to repeating an
   implementation per case, ask for a single unified API instead of picking one.

## Judging whether work is done
Hold these as **blocking**, not advisory:
- A bug fix with no end-to-end reproduction.
- A capability that did not update `README.md` in the same change.
```

Two things make these different from the `AGENTS.md` / `CLAUDE.md` that Foreman *already* reads:

- **They are direction, not evidence.** The standards docs reach the verifier fenced as material
  to judge, and a finding against them is `advisory` - so it never sends an agent back for
  another round. These reach it as instructions to follow, so they are the only way to say "this
  particular thing is not done until X" and have it actually block.
- **They can only raise your bar, never lower it.** They can make Foreman more careful -
  escalate something it would have answered, demand more before calling work finished, weigh a
  trade-off your way. They cannot authorize a destructive action, widen what it may approve on
  your behalf, retire an escalation rule, or dictate the literal text it sends to a session. That
  division is deliberate: prose shapes *judgement*, while the switches above grant *authority*,
  each with its own confirmation and its own repo allowlist. A sentence in a text box should not
  do a switch's job.

With no instructions the section renders as nothing at all, and a test pins that adding them
changes only that block, leaving the rest of every prompt byte-for-byte identical.

> **Next:** these move into a dashboard setting, stored in the database and editable from
> **Settings → Foreman**. `FOREMAN.md` stays the seed a fresh install starts from; once you save
> your own, the file is only what "Reset to default" restores. The plumbing is already in place -
> `GET`/`PUT /api/foreman/instructions`, stored under `app_config`, with empty and unset kept
> distinct so clearing the box means "judge on your own policy" rather than silently reinstating
> the default.

### Which model Foreman runs as

Foreman spawns a fresh, tool-less headless call for four different jobs, and each one picks its
own model. **Settings → Foreman → Models** shows what each is running as and lets you change it.
One **Provider** row above the four says which CLI they all spawn through - `claude -p` or
`codex exec` - and changing it clears all four boxes, since a model id does not carry across.
Left unchosen it follows the app-wide
[Models](#models-what-the-apps-own-model-work-runs-on) provider rather than a hardcoded
`claude`, so an environment variable set in the daemon's shell is not silently dropped
here.

| Call | Default | Config key | What it does |
|---|---|---|---|
| Review | `claude-opus-5` | `reviewModel` | Judges a stuck session's pending question - answer, escalate, or leave it |
| Verify | `claude-opus-5` | `verifyModel` | Reads the diff and decides whether a queued work item is done |
| Triage | `claude-haiku-4-5` | `triageModel` | The [cheap tier](#the-cheap-tier)'s Tier 1 router - buckets the ask, never solves it |
| Backlog | `claude-sonnet-5` | `backlogModel` | Reads the [backlog](#backlog-autopilot-foreman-schedules-the-fleet) once per change and orders it by what depends on what |

Each field resolves the same way: **your setting, then the environment variable, then the
shipped default**. Clearing a field means "fall back", not "run with no model" - so emptying the
box hands the decision to `FOREMAN_REVIEW_MODEL` (or the default), it never spawns the CLI
without a `--model`. The panel prints which of the three is in force, because an environment
variable set in the daemon's shell outranks the box and would otherwise be invisible from the
browser.

Any id the selected provider's CLI accepts works - the fields are free text, not a fixed list.

> Before this existed, Review and Verify passed no `--model` at all and silently inherited
> whatever the CLI happened to be logged in as. If you relied on that, set the two fields to
> match it; otherwise they now pin to Opus explicitly.

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
than Opus would. Five code backstops the router cannot override sit behind it: the destructive
denylist above forces an escalation, low confidence routes up, a window with nothing to scan
counts as *unknown* rather than safe and routes up, and a parked no-mistakes gate is never the
cheap tier's to answer - it may only escalate (cheap, and puts the gate in front of you) or
route up to the reviewer that was taught to judge one. The fifth is delivery: the router never
names a menu row, so its answer to a permission prompt (which is a menu) routes up to the full
reviewer that can name one, rather than putting every routine approval in front of you.

Pick the posture with the **Cheap tier** control in **Settings → Foreman**:

| Cheap tier | What it does |
|------|--------------|
| **shadow** (default) | runs the cheap tier *alongside* the full review, acts on the **full review**, and **records** every divergence - so its accuracy is measured before you trust it |
| **on** | the cheap tier disposes the easy cases; the full review fires only on route-up |
| **off** | every new prompt gets a full review (the pre-tier behavior) |

**Shadow's measurement is in the panel**, in the decisions ledger's *Cheap tier* column.
The panel shows that column only while **shadow** is selected, because that is the only
posture that takes a second measurement. Each measured row carries what the cheap tier
would have done and how that compared, and `cheap-over-eager` - after applying the same
delivery gate as **on**, the cheap tier would have answered where the full review would
not - is called out in red. That is the number to watch before flipping to **on**, and it
is the whole reason the posture exists. Within the column, **off** rows stay blank because
they made no cheap call, **on** rows stay blank because the cheap tier was the decision
rather than a second opinion, and rows recorded before this shipped stay blank because no
measurement was persisted. None of those blanks is reported as agreement.

The tier that produced the verdict is reported separately, and honestly: under shadow it
is always the full review, because that is the verdict that acted.

The worker log carries the same thing for anyone watching one session live: every acted
session logs the tier that decided it (`[tier 2] answer/access -> answered (sent)`), and
shadow mode adds a divergence line per session (`shadow cheap-over-eager (cheap=… opus=…)`).

### What Foreman has been deciding

**Settings → Foreman** carries the fleet-wide **decisions ledger**: every prompt Foreman
has faced, across every session, newest first - the session it happened on, the ask, what
came of it, who decided, which tier decided, and how long ago. Each of these was already
being recorded; until now the only way to read any of it was one session at a time,
through that session's Foreman drawer, so there was no answer anywhere to *what has this
thing actually been doing* - which is the question you open its settings to ask before
giving it more rope. The count strip above the table filters it: **escalated**,
**drafted**, **answered**, **skipped**. The last 100 decisions are shown, and episodes are
kept for 30 days.

The ledger is a **summary**, not the stored record: the daemon reduces each ask to the one
line the table shows and sends only that, so the captured terminal screens - by far the
largest thing in the table - never ride the 4-second poll. Open a session's Foreman drawer
for the full question, the screen it was asked on, the reviewer's brief, and what was sent
back.

The panel also states, in words, **whether Foreman is running at all**. A worker holds a
lease and renews it; when nothing does, Foreman is enabled, set to whatever mode you chose,
and nothing is executing it - a state that until now looked exactly like a quiet fleet.
That reading outranks the mode in the posture line, because a mode nothing is running is
not the fact you need first. The live figures beside it - sessions needing you, when the
last decision was, the backlog autopilot's budget - are under **Right now**, and are
deliberately a different population from the historical ledger above.

Turning Foreman on, its mode, the work queues and the on-drain action stay in the topbar
Foreman control: those are the things you reach for while watching the fleet, and the
panel is the durable posture.

## Work queues (load a session up and walk away)

Foreman above is *reactive* - it answers what a blocked session is asking. A **work queue**
is the proactive half: queue a batch of work for one specific session, and Foreman feeds it
in one item at a time, in the order you authored, checking each one before releasing the
next.

**Claude Code and Codex sessions are supported.** Codex reports pickup and completion through
the hooks Mission Control attaches to dispatched launches, and its rollout reads back as a
conversation for verification. Delivery uses the same harness-neutral pane path as Claude.
Codex renders no collapsed-paste placeholder, so Mission Control sends one Enter and records
that submission as unverified rather than retrying on evidence Codex cannot provide. A Codex
session started without reporting hooks is refused at the composer with instructions to
launch it through Mission Control, rather than accepting a batch it cannot verify.

The **Work queue** panel is a drawer, kept out of the way until you ask for it: press
**Queue** on the card (next to **Send** / **Focus** / **Reset**) or <kbd>q</kbd> on the
selected session, and it opens under the controls. The button carries the open-item count,
so you can see there's a batch waiting without opening anything. It's independent of
expanding a card - a queue is worth a glance without handing the whole grid to one session
- and stays open until you close it.

The **chip** above the controls opens the same drawer, and it's there for as long as the
session has queued anything at all - not just while work is still waiting. It reports what
the batch is actually doing: **"3 queued"** while items wait, **"3 done"** once they've all
landed, and **"1 done · 2 escalated · 1 stopped"** in the attention tone when some of them
didn't - *escalated* being work Foreman gave up on and handed back, *stopped* being work
that ended without landing at all. A session with no queued work gets a chip too, but only
while a wrap-up question is outstanding: a **"ship it?"** in the attention tone, which is
how the *prompted* trigger's ask stays reachable on a card that has no batch to show.

Only work that actually **verified** is ever counted as done, and that's the point of the
wording rather than a detail of it. Every ending is *finished* in the sense that nothing
will advance it again - landed, escalated and cancelled alike - so a chip that counted
"finished" work would report a clean-looking total over a batch that quietly stalled. An
**exited** session has no controls at all - no **Queue** button - so the chip is the only
thing left saying what its batch did, which is why it outlives the work and why it doesn't
flatter it.

Two ways to get the room back, for two different intents. **Queue** (or <kbd>q</kbd>) puts
the drawer away entirely. Clicking the panel's **Work queue** header *folds* it instead -
down to a title bar that still reports the count, so a long batch stops taking up the card
without you losing sight of it. Fold state is per card and survives closing and reopening
the drawer.

On an **expanded** card the queue doesn't sit above the conversation at all - it moves into
a column beside it. An expanded card is full-width and the scarce thing is height, so
stacking them meant the queue and the log competed for the same pixels and a long enough
queue pushed the conversation off the bottom of the card. Side by side, neither can take
anything from the other: the log keeps its full height however much work is queued. Below
about 820px wide there isn't room for two readable columns, so it stacks again - and there
the queue is capped at 40% of the space it shares with the log, which always keeps the
larger half.

Inside it: type an intent, press <kbd>Enter</kbd> (or **Add**), repeat - the same contract
as the reply box on the same card, with <kbd>Shift</kbd><kbd>Enter</kbd> for a newline when
an intent needs more than one line. The box also
takes **dropped or pasted images**: the upload starts on drop, and what's queued is the
uploaded file's *path*, so the agent reads it with its own file tools whenever the item is
finally delivered. **Add** stays disabled while an upload is in flight, and an image with no
words is a valid item. The same gesture works on the card's transcript reply box and the
dispatch form. Items are drag-reorderable, editable, and removable while they wait -
and **editing** one obeys the same <kbd>Enter</kbd> saves / <kbd>Shift</kbd><kbd>Enter</kbd>
newline contract, because the edit box and the add box are the same textarea to look at and
sit inches apart: the panel has one Enter rule, not two. Then walk away. For each item
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

When Foreman decides a session is finished it can **wrap it up**. Two independent choices in
the popover: **Trigger on**, one or more moments that count as finished, and **Then**, the
single action to take at whichever one fires.

| Trigger on | Fires when |
|---|---|
| **Queue drain** (default) | every item in the session's queue reached a terminal state |
| **Prompted work complete** | you typed straight into the pane, the agent worked, and it parked - no queue involved |

The prompted trigger doesn't fire on idleness alone, because idle isn't finished. It runs
the same verifier queued items get - a fresh tool-less `claude -p` reading the branch diff
against your captured prompt - and acts only on a **complete** verdict; an empty diff
decides itself without a model call. A session that still needs you is left alone, and a
checkout that *has* a work queue belongs to the drain trigger, which wins. It fires once
per prompt: a new prompt from you re-arms it, and an incomplete verdict retires the
episode rather than sending the agent back - Foreman didn't commission that work. Untick
both triggers and Foreman never wraps up on its own.

The action is the same whichever trigger fired:

| Then | What it does |
|---|---|
| **Ask me** (default) | marks the moment; you pick from the **Ship it?** card, and an alert points you at it |
| **Run no-mistakes** | types the gate instruction into the session itself, spelled for that session's agent |
| **Straight to PR** | explicitly skip no-mistakes; use git and `gh` directly to commit, push, and open a PR - then merge the default branch in, resolve conflicts, and follow CI until every check passes |

The two automated actions type something that *pushes*, so they only fire in **live** mode
on an **allowlisted** repo - until then Foreman asks, and the popover says so rather than
letting a selected radio quietly do nothing.

**The gate instruction is spelled per harness**: `/no-mistakes` for Claude and a
`$no-mistakes` instruction with a trailing clause for Codex. The clause is load-bearing
rather than decorative - a bare `$name` at the end of Codex's composer leaves its
skill-mention popup open, and that popup swallows the Enter that would have sent the
message. Pi's invocation is `/skill:no-mistakes`, though Pi work queues are not currently
supported. The same rule reaches the **Ship it?** card, so the button and the automation
send identical bytes.

**Verification is evidence-only by design.** It reads the diff and the transcript - it does
not run tests. no-mistakes remains the gate that actually executes things; Foreman's job
here is the narrower question no pipeline answers: *was the thing you asked for actually
done?* Gaps carry a severity, and only **blocking** ones send the agent back - a style nit
lands as advisory, shows on the card, and never costs a round. Two knobs in the Foreman
popover bound it: **fix attempts per issue** (default 3) and **max fix rounds per item**
(default 10, the hard stop).

Sends obey the same gate as everything else: dry-run **drafts** each item and waits for your
**Approve**, and live sends only happen in allowlisted repos. Verification is read-only, so
it runs in any mode - you see Foreman's judgment before it ever types. A queue needs hook
pickup/completion signals: Claude sessions must report installed hooks, Codex sessions must
have the launch-scoped hooks attached, and Pi is unsupported. The panel says so rather than
letting you queue work that can't run.

### Keeping a PR on track

Wrapping up turns work into an **open pull request** - and then the session parks. The
[Inspector](#inspector-automated-pr-review) reviews that PR and posts comments, or CI goes
red, and nobody is driving the session to fix any of it, so the PR sits with unresolved
feedback until you notice. **Keep sessions on track** (in the Foreman popover, under **Pull
requests**, **on by default**) closes that gap: it nudges the parked session back onto its
own PR to **resolve the Inspector's review comments and get a failing CI green**, and nudges
again when a later Inspector round or a newly actionable feedback kind changes what needs
attention.

It applies to parked sessions on harnesses Foreman can reliably drive - currently Claude,
and Codex sessions launched with Mission Control's scoped hooks - whether the PR came from
**Straight to PR**, an automatic **no-mistakes** wrap-up, or one you shipped by hand.

The nudge is typed into the session's pane, so it carries the usual gates and one more:

- it only **types** in **live** mode on an **allowlisted** repo, exactly like the automated
  wrap-up actions - dry-run leaves the parked PR for you;
- it fires only at a **settled-idle** session, so it never interrupts one already working the
  fixes, and it does not nag a PR that's being handled: review comments re-arm **once per
  Inspector round**, and a failing CI re-arms **once per failure episode** - after the checks
  recover, a later failure counts as new (so a red CI is never permanently silenced, and a
  CI that merely goes green does not re-nudge the comments already relayed);
- it stands down while a **no-mistakes run is still driving the branch**, while the session
  **needs you**, and while it has a live **work queue** (the drain trigger owns that
  checkout);
- **once that run has opened the PR and only its `ci` step remains running**, with no
  approval gate waiting for an answer, it is parked in the PR monitor and the nudge is
  back on for review comments. A no-mistakes run reports `running` for as long as that
  step watches the PR - until the PR merges, closes, or the monitor times out - and so
  covers the whole window in which Inspector comments normally arrive. The monitor keeps
  ownership of the **CI half** (it watches the checks, rebases a branch that falls behind,
  and fails the run when they go red), but it has no answer for review comments and is
  waiting on a merge those comments [block](#shipping-yolo-mode). So unresolved
  **Inspector comments** are relayed while CI is not failing; a **failing CI**, including
  one alongside comments, is left to the monitor, which reports it before a later pass
  relays anything still open;
- the review-comment half counts only Inspector findings **already posted on the PR**
  (dry-run drafts and findings still being posted do not count) - the failing-CI half works
  regardless.

## Backlog autopilot (Foreman schedules the fleet)

A work queue drains one *session*. The **backlog autopilot** drains the *fleet's*
[backlog](#dispatch-an-agent) - the items you've queued but not started. Foreman reads the
planning head - up to 400 items, including held ones - to preserve its dependency graph,
then schedules enabled, ready items one at a time: onto an agent that's already idle when
there is one, or into a fresh worktree when there isn't - never past a ceiling you set.

Three knobs, in the Foreman popover under **Backlog**:

| Knob | Default | What it does |
|---|---|---|
| **Auto-schedule the backlog** | off | arms the autopilot |
| **Max agents running at once** | `3` | the ceiling it won't launch past |
| **Open PRs keep an idle agent off the backlog** | on | an agent whose branch still has an unmerged PR is not handed the next task |

**Max agents counts every live agent on the machine**, not just the ones Mission launched -
it's a statement about your machine's load, and a count that ignored the six sessions you
started by hand wouldn't be one. It bounds *autopilot* only: it never refuses a dispatch
**you** clicked, because blocking a button you pressed to protect a background scheduler's
budget is the worse surprise. A backlog item's
[on/off switch](#hold-a-backlog-item-back) is scoped the same way - it holds the machine
back, not you. An unmet dependency is different: it is a task-level ordering
constraint and blocks every scheduling path, manual ones included.

**It only ever launches in Live mode, on an allowlisted repo** - the same gate the
automated wrap-up actions clear, for the same reason. Launching an agent starts unattended
work, and handing a task to a running agent types a whole prompt into a pane you may be
sitting in front of; both are more consequential than answering a prompt. In **dry-run**
and **semi-auto** it still *plans*, so you see the ordering and the dependency read on the
board and can click **launch new agent** yourself. Dry-run means dry-run.

**Foreman's inferred dependencies come from a model, and are treated as one.** A fresh
tool-less `claude -p` (Sonnet by default - `FOREMAN_BACKLOG_MODEL`) sees every planning
item's title and intent and returns an order plus, for each item, what it must
wait for. The reply isn't trusted as written: ids that aren't in the backlog are dropped,
self-references are dropped, **only the edges that close a cycle** are cut, and any item
the model forgot is appended unblocked. A cycle would deadlock two cards forever and look
exactly like two cards waiting their turn;
a forgotten item would leave the plan permanently stale, which is an unbounded replanning
loop. Every dependency that isn't part of a cycle survives, whatever order the model listed
the items in, and the plan is stored in dependency order. The read re-runs only when the
planning head **gains an uncovered item**, so a steady backlog costs nothing.

Operator-selected dependencies from the dispatch form are separate, persisted facts. The
planner sees them, cannot reverse or remove them, and its inferred graph is sanitized
against them so an inferred reverse edge cannot deadlock the backlog. Those facts remain
enforced when autopilot is off or its model plan is missing.

**The read's time budget scales with the planning backlog** (`60s + 20s` an item,
capped at 10 min; `FOREMAN_BACKLOG_TIMEOUT_MS` pins a flat one instead). It has to: the
model writes one entry per item, so two dozen items take minutes of wall clock where
a handful takes seconds. A fixed cap worked on a short backlog and then stopped working for
good once one grew past it - every read timed out, so no plan was ever stored, so the
autopilot re-read the same backlog every tick and scheduled nothing while the board showed
ready items and an idle fleet. Three failures in a row and
Foreman stops asking and schedules **one task at a time, oldest first** - serial execution
satisfies any dependency order by construction, so a broken planner degrades to slow rather
than to wrong. That's a cooldown, not a latch: after `FOREMAN_BACKLOG_RETRY_MS` (10 min)
one fresh read is tried, so an API blip heals itself instead of waiting for a restart. A
daemon that refuses to *store* a plan degrades the same way rather than halting, on its own
counter and its own backoff.

One read, one model call, over the **first 400 backlog items**, including any
[held back](#hold-a-backlog-item-back) - they stay in the read so the edges pointing at
them survive it. Reading a
longer backlog in several calls was tried and taken back out: they run on the Foreman
worker's single loop, which also drives queue drain and needs-you triage, so each extra call
is another span in which nothing else in the fleet is attended to. Past 400 the
tail is scheduled **oldest first with no dependency information** - and, since staleness
is coverage, a dispatch while the backlog is that long promotes an unplanned item
into the head and costs one replan.
That is the accepted trade: one call, only above 400, in exchange for a bounded worst case
on the shared loop.

**An idle agent is preferred to a new worktree**, and that preference survives the ceiling,
since it consumes no new session. "Idle" is stricter here than the board's Idle column: the
agent must be settled, hook-instrumented (an autopilot that can't observe a session must
not type a whole task into it), have a pane, have no work queue of its own, no review
waiting on you, **no open PR on its branch**, be in the same repo, and be **the harness the
task was filed for** - a Codex task is never typed into a Claude pane unasked. The daemon
re-checks on arrival, because an agent can go busy between the decision and the request.

**An agent that shipped is not an agent that's free.** An agent which opened a PR and went
quiet looks identical, on every other signal, to one that finished with nothing left to
protect: it reads idle, its queue is empty, and once you mark its task done nothing binds
it. Handing it the next item would type into a checkout still standing on the PR's branch,
so the new work lands on a change that's out for review. So an **unmerged PR keeps the
agent off the backlog** until it merges - turn off **Open PRs keep an idle agent off the
backlog** if your PRs auto-merge and you'd rather have the throughput. A *merged* PR never
blocks; it lingers on the card so you can see the work landed. This narrows *autopilot*
only - dragging a task onto that agent yourself still works, because that's you saying
"yes, that one".

**A reused agent is reset before it's handed anything** - the same reset, and the same
refusals, as [dragging a card onto an agent
yourself](#hand-a-shelved-task-to-an-agent-thats-already-running). It keeps its own
checkout, so without this the next task inherits the last one's branch and context, and
the agent would push two unrelated tasks into one PR. A checkout holding anything origin
can't give back sends the task straight back to the backlog with a line saying what's in
the way; nobody is watching this one, so the only thing it may not do is quietly discard
your work.

Autopilot **confirms the rest of that reset unattended**, and it has already ruled out
what the confirmation protects: an agent is only "free" here with an empty work queue,
and clearing the context is how a handover works at all.

On the **board**, the Backlog column shows the
[hold switch and its disabled state](#hold-a-backlog-item-back), a **blocked** chip naming
what an item waits on, and a **next up** mark on the one Foreman would take next. A card
blocked only by Foreman's inferred dependencies stays draggable and launchable
(**launch anyway**), because the model's read is an opinion. An operator-selected
dependency is authoritative: its card reads **waiting for dependencies** and cannot be
launched or assigned early. The Foreman popover carries the live readout -
`2/3 agents · 4 ready · 1 blocked · 1 disabled` - so "why is nothing launching?" is
answerable without reading a log.

## Half-written text is kept

A session card **keeps what you've typed** until it's actually delivered. Three of its
boxes hold a draft:

- the **Work queue** panel's add box,
- the **reply** box under the transcript on an expanded card, and
- the **send** box - opened by <kbd>s</kbd> on the selected session, or by **Send** on the
  card.

A card only ever has **one** box to send from - at any moment, in every state. The rule
keys off whether a reply box actually *exists*, not off whether the card is expanded:
whenever the transcript is carrying one, <kbd>s</kbd> and **Send** put the cursor *there*
rather than opening a second, and a send box already open closes itself the moment a reply
box appears. When there's genuinely no reply box - an expanded card whose transcript can't
be read renders no reply row - **Send** opens the card's own box, which is exactly right:
one box either way. Nothing is lost when one closes, because the text is in the draft map;
press **Send** again and it's waiting in it.

Each survives everything that isn't you deleting text: **collapsing the card** (opening any
other card collapses this one - only one is expanded at a time), a **filter** that hides the
card, and **Cancel** / <kbd>Esc</kbd> on the send box. Glance at the grid mid-sentence and
come back - your text is still there, exactly as the [dispatch form](#dispatch-an-agent)
treats a half-written task.

A draft is forgotten on **successful delivery**: a send that lands for the reply and
send boxes, an **Add** that lands for the queue box. **Resetting the session** also forgets
the reply and send drafts - a reset discards the task those boxes were replying to, so their
half-written text goes with it, and an open reply box empties on the spot rather than keeping
stale text behind the closing modal. The **queue add box is kept** through a reset, since it
composes new work rather than a reply to the discarded task. A send that *fails* deliberately
keeps your text - it's all you have and you're about to retry it. Drafts are per session and
never bleed from one card into another.

Two things worth knowing:

- The scope is this **browser tab**. A reload starts over; drafts aren't stored anywhere.
- **Images are the exception - only the text comes back.** A screenshot dropped on the queue
  add box is gone once you close the drawer, and one on the reply box once the card
  collapses, so attach yours when you're ready to send. (The
  [dispatch form](#dispatch-an-agent) is the one that keeps its attachments across a close.)

## Skills (every session, mixed reload behavior)

Settings (the topbar gear, or ⌘,) has a **Skills** catalog: read what a skill does,
switch it on, and it applies to **every** session on this machine whose harness has a
skills directory - including sessions this app never launched. How a running session notices
the change depends on its harness.

Skills are ordinary native harness skills, living in `skills/<id>/SKILL.md` in this repo
so they're versioned and reviewed with the app. Enabling one symlinks it into
`mission-<id>` under **each declaring harness's own directory** - `~/.claude/skills` for
Claude, `~/.agents/skills` for Codex, and `~/.pi/agent/skills` for Pi - which is that
agent's own loading path; the harness never reimplements it.

The opt-in **Pull Request** row applies whenever a session prepares, opens, or reports a
PR. Its reviewer-ready description contract lives in
[`skills/pull-request/SKILL.md`](skills/pull-request/SKILL.md).

The opt-in **Phased Plan** row investigates an approved plan against the repository, writes
merge-aware phase documents beside it, and schedules one dependency-linked backlog task per
phase. The HTML Plans review always offers this as its final selectable follow-up; choosing it
passes the approved plan and submitted decisions into
[`skills/phased-plan/SKILL.md`](skills/phased-plan/SKILL.md).

**Being loaded and being noticed are two capabilities, and only the second differs.** A
Claude session re-reads its directory only when told, so the daemon types `/reload-skills`
into its pane when it next goes quiet. Codex declares no reload command, because it
watches its own directory - which means a Codex session picks the change up with nothing
typed at it at all, and is deliberately excluded from the pane broadcast rather than sent a
slash command that would land in its composer as text. Pi's reload is launch-scoped: a Pi
session dispatched by Mission Control has an injected identity, so its exact transcript can
prove idle and the daemon can safely type `/reload`; an operator-started Pi session has no
such binding and picks changes up only on its next launch or restart.

Three things worth knowing before you switch one on:

- **The blast radius is the point, and it's global.** These are your own directories,
  shared by every agent of that kind on the machine. The harness only ever creates or
  removes entries under its own `mission-` prefix (and the `fleet-` one it used
  before the rename), and only ones that are symlinks - your
  `no-mistakes`, `implement-plan` and friends are untouchable by construction, not by
  care. **Turning the master switch off is the real uninstall**: it's the only control
  that both removes every link and records that you wanted them gone, so nothing brings
  them back. Removing the links any other way is temporary - the daemon reconciles
  every declared directory against this config on every start, so a config still saying
  "on" re-creates them. (The tray's "Remove Claude integrations" is hooks and the MCP
  server only; it does not touch skills.)
- **Enabling a skill loads it; it does not oblige the agent to use it.** Native skills
  are model-invoked, so each row carries an **enforcement badge** saying which rung it
  sits on. "When relevant" means exactly that.
- **The "N sessions will pick this up" count is about the reload nudge, not about
  reach.** It counts the sessions the daemon will type at, which is the ones whose harness
  declares a reload command and whose per-session readiness source is currently available.
  It excludes Codex sessions that watch automatically and operator-started Pi sessions that
  require a restart, while counting identity-bound dispatched Pi sessions. Reach is the
  `skills` capability; the count is the reload-readiness contract, and they are
  deliberately different questions.

### The daemon is no longer strictly reactive

**Read this before adding another autonomous writer.** Until skills shipped, the daemon
typed into a pane only downstream of a route call - which meant downstream of a person.
The only unprompted typing in the system was quarantined in [Foreman](#foreman-auto-responder),
a separate, leased, opt-in worker process. The skills reload loop
(`src/server/skills/reload.ts`) ends that invariant: it runs *in* the daemon, holds no
lease (the port bind is the mutex - two daemons can't both hold `:7317`), and types on
its own schedule.

The gate that makes it safe is not paperwork. `injectPrompt` presses Enter
unconditionally, and a Claude dialog is a **select list, not a text prompt**: pasted
text is swallowed and the Enter activates whichever option is highlighted. Fired
across every session, that's an unattended answer to a permission prompt nobody read, in every
pane at once. So a reload requires `settledIdle` (a *reported* idle, not the
uninstrumented default) **and** a pane read confirming Claude's mode line is on screen,
which a dialog or menu replaces. If you add a second autonomous writer, it needs the
same gate, and it needs `withPaneLock` in `actions.ts` - the reload loop is why that
guard covers every pane write rather than just permission-mode cycling.

[Task sources](#task-sources-pulling-work-into-the-backlog) are the worked example of the
other answer. The sweeper also runs in the daemon, holds no lease and acts on its own
schedule - and it needs **none** of that gate, because **it never types**. It writes
backlog rows: no pane is read, no keystroke is sent, nothing is provisioned. That is why
the test is "does it type?" rather than "is it autonomous?". The moment a source can type,
this whole argument has to be redone for it.

The mutual exclusion is the **port bind**, and it holds for the default port: a second
`npm start` can't take `:7317`, so there's exactly one reload loop. It does *not* hold
for `MISSION_PORT=<other>`. A daemon on a spare port is a second, fully autonomous writer
aimed at the same real panes - discovery finds the same sessions whatever port you serve
on, and an isolated `MISSION_HOME` makes it *worse*, because its ack table is empty and it
believes every session is owed a reload. If you're testing against a spare port, know
that its reload loop is live from the moment it boots.

## Settings

Settings is a **page**, not a modal: `#/settings/<category>` in the URL, reached from the ⚙
gear in the top bar, from **Mission Control → Settings…** / <kbd>⌘</kbd><kbd>,</kbd> in the
desktop app, or by opening the link directly. <kbd>Esc</kbd> returns you to the fleet, the
gear takes you back the same way, and browser back/forward walk the categories you visited.
While the page is up the fleet's shortcuts stand down, exactly as they do on Workflows -
nothing you type here can drive the session behind it.

The rail is grouped by **blast radius**, and each group carries a badge saying how far its
settings reach. That is the question a flat list of twelve peers could not answer: which of
these stays in this browser, and which of them acts publicly under your account.

| Group | Reach | Categories |
|-------|-------|-----------|
| **This screen** | This browser | **Display** (layout + message formatting), **Keyboard** |
| **Sessions** | This machine | **Harnesses**, **Skills** (writes `~/`), **Cost** (writes `~/`) |
| **Background work** | This machine | **Foreman**, **Workflows**, **Task sources**, **Models** |
| **Leaves the machine** | Acts on GitHub | **Inspector**, **Shipping**, **Trust** |

The badge on a group is the general case; the badge in a panel's own header is that
category's precise claim, which can be stronger - Skills sits under *This machine* and
symlinks into `~/.claude/skills` and `~/.agents/skills`, so its own badge says `Writes ~/`.

Two things changed shape when the page arrived. **Layout and Appearance merged into
Display**: both are one browser's preferences about how this screen draws the fleet, and a
category holding a single checkbox sat as a visual equal of the one that merges pull
requests. And **Task sources is master-detail** - the directory of configured sources beside
the one you are editing, instead of a drill-in that hid the other three while you repaired
the one that failed. Adding a source is an inline form above that list; it still resolves the
repo before the source exists, and the source still starts switched off.

**Workflows** joined the rail later, from a floating drawer on the Workflows page. It carries
the same four things the drawer did - the [Live delivery](#live-repair-delivery-and-foreman-completion)
switch and its explicit warning, the repositories Live delivery may send in, the
[retention](#retention-history-exports-and-workflow-health) limits (shortening one still asks
first), and the health counters - on the same routes, with nothing about the config changed. What
it gains by being here is everything a drawer could not have: a rail row, a scope badge, a deep
link, and a place in ⌘K, so the one switch in this app that can type into somebody's live agent
session is findable by searching for what it does. The Workflows page header keeps a link to it.

**Inspector, Shipping and Foreman are consoles**, not forms: the controls sit in a narrow
column and a per-item ledger takes the wide one, under a strip of counts. That is the
split those three panels needed and the other nine do not - their knobs are set once,
while their ledgers are read repeatedly and answer the only questions those subsystems
raise (*what did the review say*, *why has nothing merged*, *what has Foreman been
deciding*). As a 12px list at the foot of a vertical form, the ledger was the least
legible thing on the page and the most important. **Every tile in the count strip is a
filter**, and there is a tile for every state a row can be in, so the numbers always add
up to the rows underneath - a strip that ignored the closed pull requests read "1 with
findings, 0, 0, 0" over a table of fifty.

**Workflows takes the same cards without the split**, because the console shape is three
separable things and a panel should take the ones it has the data to be honest about. It has
no ledger to put in a wide column: the Workflows page already owns the run list, with paging,
live updates and per-run actions, and a second copy in a settings panel would disagree with
the real one the first time either changed. So its single column stays a single column, and
its health strip **navigates instead of filtering** - each tile opens the nearest
corresponding run-list view, with a status filter where one exists, rather than pretending to
select rows this panel does not have. Those tiles count fleet-wide totals over different
populations and deliberately do not add up to anything.

Foreman's ledger is **fleet-wide**, which is the one thing no other surface shows: every
decision it has faced across every session, newest first, where before this the record
was readable only one session at a time through that session's drawer. Its strip is
folded from those rows and not from the live-session counts in the topbar - the two are
different populations by design, and a tile that disagreed with the rows under it would
make every other number on the panel worth nothing.

Deep links work for every category, and the whole list is stable enough to paste into an
issue: `#/settings/shipping`, `#/settings/task-sources`, `#/settings/models`. A link naming
a category this build does not have falls back to Display rather than a blank pane - the one
browser-scoped category, so a stale link can never open a panel that acts on GitHub.

**Status dots** on the rail say what each subsystem is doing without opening it, and they
move over the live channel - no polling, and right whenever the app is open, not only while
a panel is on screen. **Inspector** is green when it is switched on and live (reviews post
to GitHub); **Shipping** is amber when YOLO mode is armed; **Task sources** is red when a
source failed its last sweep; **Foreman** is purple when the auto-responder is on; **Trust**
is amber when YOLO is armed with a merge-without-review blind spot. The topbar ⚙ **gear
inherits the worst of them** - red over amber over green - so a subsystem that needs you
shows from the fleet; the gear's tooltip names what the dot means. Before the first status
arrives (a cold tab, a reconnect) the dots stay dark rather than claim an all-clear.

### Search settings (⌘K)

Roughly seventy controls span the twelve categories, so **search** is how you reach one you
half-remember without knowing which panel it lives in. Open the palette with <kbd>⌘</kbd><kbd>K</kbd>
(rebindable, like every other shortcut - **Settings → Keyboard**) or the **search box at the
top of the rail**, which shows the current chord as its hint. From the fleet the shortcut
jumps to the page and opens the palette in one step; the topbar ⚙ gear keeps its one job of
navigating to the page. Type any part of a control's name, description, or keywords -
matching is plain substring, so the same query always returns the same rows in the same
order, no fuzzy guessing. Arrows move the selection, <kbd>Enter</kbd> acts on it,
<kbd>Esc</kbd> (or a click on the dimmed backdrop) closes.

The index covers controls, not content: every switch, picker, model field and sub-panel is
in it, but repo names and PR numbers are not. A **boolean control flips inline** right in the
results - the switch re-reads the daemon on the next poll, so a change that has not landed
shows honestly as unmoved rather than an optimistic guess. Everything else - a scalar, a
picker, a whole panel - **jumps** to its category and flashes the control it named.

The one exception is the **risky set** - YOLO mode and the Inspector's enable and mode. Those
never flip from a search result: they always jump to their panel, so the consent copy that
explains what merges or gets published is on screen when they change. A category-name match
also appears, under **Jump to**, so searching "shipping" or "keyboard" lands you on the
whole panel.

### Trust (who may act in which repository)

Three subsystems act on GitHub under your account, and each keeps its own list of the repos
it is allowed to act in: Foreman sends live, the Inspector posts reviews, and Shipping
(YOLO) merges. **Settings → Trust** (`#/settings/trust`) is one table over all three - a row
per repository, a column per grant - so the whole surface of "what may act where" is on one
screen instead of scattered across three panels.

- **It is a view, not a new store.** Each column is the subsystem's existing allowlist;
  ticking a cell writes to that subsystem's own config through the same route its panel used
  to, and the daemon's three consent gates are unchanged. The Foreman, Inspector and Shipping
  panels now show a grant **count** and a **Manage in Trust** link where their repo editors
  used to be - a grant is not the same permission in each column, which is the whole reason
  they stay three lists.
- **Adding is configuration; enabling is consent.** Adding a repo (resolved and canonicalized
  first, so a typo is refused) stages an empty row and grants **nothing** - every cell starts
  off, one deliberate click each. A staged, ungranted repo is remembered per machine so it
  survives a reload before you come back to grant it.
- **Worktrees count too.** A grant names the **repo**, so a session in any worktree of a
  granted repo is covered, wherever that worktree lives on disk.
- **The blind spot is visible.** If YOLO may merge in a repo the Inspector may not review,
  nothing there can ever qualify - the merge cell and the empty review cell both go amber, and
  a footnote offers the two fixes in place: **grant the review**, or **revoke the merge**.
  Shipping's own dependency warnings link straight here. The rail's Trust dot summarizes the
  same blind spot.

## Layout (cards, console, or board)

The same fleet, three shapes. **Settings → Display → Layout** (the ⚙ gear, or <kbd>⌘</kbd><kbd>,</kbd>)
switches between them live, and the choice persists per machine:

| Layout | Shape | Good for |
|--------|-------|----------|
| **Cards** (default) | Every session a card in a responsive grid; one expands in place to fill the screen. | The general case, and the most detail per session without clicking. |
| **Console** | A dense rail of every session with one always-open detail pane beside it. | Working *one* session while keeping an eye on the rest - the conversation is permanent, not a click away. |
| **Board** | A column per state; clicking a card - or pressing <kbd>Enter</kbd> on the one the arrow keys are on - drills that column into the console's detail. | Reading the fleet's shape at a glance. "How many need me" is a column's height, not eight badges. |

Switching layouts does not change the underlying sessions. Controls repeated across
surfaces come from the *same* leaf pieces so their behavior stays aligned. What changes is
how they're arranged - dense overview surfaces select a subset, while Console and the
Board's drill-in expose the complete detail - and the console's permanent conversation
earns two surfaces a card has nowhere to put:

- **Cards** renders the full session card. The **Console** gives
  the selected session a bespoke, tabbed detail instead - **Conversation / Work queue /
  Gate / Diff / Files** - because a split pane has room a card doesn't: the conversation is
  permanent, and the sections that share a card's height in the grid get a tab each. The
  **Board** drills into that same detail when you open a card. In Console and Board, the
  Diff tab contains the complete checkout diff reader; the footer action, <kbd>d</kbd>, and
  a no-mistakes fix's **View diff** all reveal it in place. Opening the tab itself shows the
  whole-checkout diff, while **View diff** shows that one fix commit. Cards keep the diff in
  a modal viewer.
- **The console's two extras are Foreman's**, and both need a conversation to exist:
  its notes render inline in the transcript, and a **Foreman · N** rail at the far end of
  the tab row opens their history. The rail is deliberately *not* a fifth tab - Work queue,
  Gate and Diff are things the session *has*, while Foreman is an observer talking *about*
  it. A card keeps the full note block instead, since it has no transcript to inline into.
- **Cards** is the only layout with an in-place focus mode, so its floating command bar is
  unique to it. On the **board**'s overview <kbd>e</kbd> (expand) opens the drill-in the way
  <kbd>Enter</kbd> does, and closes it again. In the console, and in the board once you're
  drilled in, the open detail *is* the selected session, so there is nothing left to expand,
  and its controls are on screen permanently instead of on a bar that floats over them.
- **Selecting is opening in the console**, and the keyboard walks it left to right. Click a
  rail row - or walk it with <kbd>↑</kbd>/<kbd>↓</kbd> - to switch sessions; the selected row
  wears a bright selector frame so it never gets lost against a busy state. Press
  <kbd>Tab</kbd> to step INTO the open detail: it lands on the conversation pane, which takes
  a soft ring, and <kbd>↑</kbd>/<kbd>↓</kbd> scroll it. Each further <kbd>Tab</kbd> moves one
  tab right - Conversation, Work queue, Gate, Diff, Files - with <kbd>↑</kbd>/<kbd>↓</kbd>
  scrolling whichever is showing, and it clamps at the last rather than tabbing away.
  <kbd>⇧</kbd><kbd>Tab</kbd> walks back the same way, and from the conversation hands the
  keyboard to the rail. The reader is chosen by where focus actually is, so a single
  <kbd>Tab</kbd> reaches it whatever a click last left focused - except while you are typing
  in the filter or the reply box, where <kbd>Tab</kbd> stays native. In the focused inline
  Diff reader the arrows move through its file list instead.
  <kbd>Esc</kbd> peels back one layer at a time - reader to rail, then deselect, emptying
  the pane. **The board's drill-in reads the same**: opening a card morphs its column into
  this rail-plus-reader, and every key here behaves identically there.
- **The board separates the two**, because its overview is worth reading without being
  dragged through every transcript on the way. The arrow keys move a visible cursor from
  tile to tile and open nothing; <kbd>Enter</kbd> drills the selected one into the console
  detail, and <kbd>Esc</kbd> comes back out with the cursor still on the card you left. Once
  you're in, the arrow keys keep moving the open detail through the board - the drill-in
  is always the selected session. Clicking a tile still does both in the one gesture.
  Acting on the cursor works either way: <kbd>s</kbd>, <kbd>f</kbd>, <kbd>q</kbd> and
  <kbd>k</kbd> pressed on the overview drill in and then do what they say. The one exception
  is <kbd>⇧</kbd><kbd>Tab</kbd>, which cycles the selected tile's permission mode in place
  without opening its detail.
- **An [ensemble](#multi-agent-ensembles)'s members are drawn together, in every layout.**
  Sibling candidates of one run used to scatter through the fleet like unrelated work; now one
  ordering decides where every session goes, and it puts them adjacent. On the **Board** they
  sit inside a framed group whose header names the run, its strategy, where it is in operator
  words ("reviewing", "waiting on you"), one dot per member of the roster, and an attention
  rollup - **N needs you** when a member *in that frame* is holding a question, or a quieter
  outlined **N elsewhere** when the run has one in another column. Click the header to open the
  run. The **Console** rail (and the board's drill-in, which is the same rail) gets a slimmer
  version above the members' rows - the title, the stage word, the dots and a compact `!N`
  attention count, but not the strategy, which at the rail's narrowest would cost the run's own
  name the room it needs (it stays in the hover copy, and on every member row's chip). Arrow
  keys walk straight past the header, so navigation is unchanged. **Cards** sorts siblings next
  to each other but grows no frame: its arrow keys are geometric against the live CSS grid
  tracks, and a header cell would silently break <kbd>↑</kbd>/<kbd>↓</kbd>.
  A cluster never crosses a Board column: if one member is waiting on your answer it sits in
  **needs you** with the run's header repeated there, rather than dragging its working siblings
  out of the column that describes what they are. Dragging a backlog card onto a clustered tile
  works exactly as it does anywhere else - the frame is a drawing, not a drop target.
- **Killing a session closes its detail**, without waiting for the session to disappear -
  the board goes straight back to its columns, the console empties its pane, and Cards
  leaves focus mode with the card still selected. A killed session lingers for a few
  seconds before it's evicted, and there's nothing left to read in it.
- **Double-click a column head to widen that column.** A board column is sized for a
  glance, and sometimes a glance is not enough: titles wrap to three lines, goals clamp at
  two, and a blocked chip ellipses after four words. Double-clicking the head - or pressing
  the **‹›** toggle that appears in it on hover - gives that one column roughly twice a
  normal column's share of the board, and its cards **reflow** rather than stretch: the
  title takes the full width on its own line and every mark below it joins one line, so a
  card gets *shorter* as it gets wider and more of them fit on screen. Double-click again,
  or press **›‹**, to put it back. One column at a time, and the neighbours keep their own
  minimum width, so widening the Backlog never squeezes the column holding the live agents
  down to nothing. It's a gesture rather than a setting: it isn't persisted, and opening a
  session drills in exactly as it did before.
- **The filter box (<kbd>/</kbd>) narrows the whole board, backlog included.** A query is a
  case-insensitive substring match against a session's title, status and agent - and, on the
  board, against a backlog task's title, status, agent and labels. So `ghostty` finds the
  queued *P5: Ghostty terminal emulator adapter* whether or not any live session matches, and
  the board stays on screen to show it. Cards and Console draw no tasks, so there a query
  matching only backlog items correctly reads as "nothing matches".
- **The arrow keys follow the shape** - see below.

## How much conversation you see

For the Conversation panel's complete, paged history, see
[Reading a session's whole conversation](#reading-a-sessions-whole-conversation).

One-shot context readers such as Foreman's reviewer and the goal refiner keep the opening
turns plus the most recent ones, and mark the middle as elided when necessary. The work
queue's verifier instead reads forward from the item's delivery point, keeps up to 48
recent turns, and reports when it had to drop an older prefix.

## Open a checkout file outside Mission Control

The Files workspace reads and edits the checkout in place, and its HTML preview is
deliberately inert: the sandbox gets no scripts and no network access. That is the right
trade for a preview pane and the wrong one for a mockup with any JavaScript in it, so the
file toolbar carries **Open in ▾** - it hands the file on screen to an application outside
the dashboard, where the document is just a document again and resolves its own relative
assets.

**Browser** is the target this build ships. It is not `open <file>`: the platform's default
handler routes by file TYPE, which lands an `.html` mockup in your browser and lands
`routes.ts` in whatever editor claims `.ts`. The Files list holds every file in the
checkout, so a row that says "Browser" resolves the application you actually chose for the
web - on macOS the bundle LaunchServices hands `https` to, on Linux what
`xdg-settings` reports (falling back to `xdg-open`, which can no longer name the
application, and says so rather than guessing). The row names what it found, so you can see
*Browser · Chrome* before clicking.

- **What opens is what you are looking at.** Autosave is 750ms behind the keystroke and
  every target reads the file from disk, so a pending save is flushed and waited on first.
  If it cannot be written - offline, or a conflict with an edit made outside the dashboard -
  nothing opens and the toolbar says so, rather than quietly showing the previous version.
- **Files the editor cannot open still open here**, which is the point for images, PDFs and
  anything over the 2 MiB editor limit: the workspace says "binary files cannot be opened"
  and the browser shows them perfectly well.
- **What the browser then does with the file is the browser's call.** It renders what it
  knows - HTML, images, PDF, SVG, plain text - and *downloads* what it doesn't: Chrome puts
  a `.yml` or a `.ts` in your Downloads folder rather than displaying it. That is worth
  knowing before you reach for this on source, and it is the gap a future **Editor** target
  fills; nothing here second-guesses it with an extension allowlist, because which types a
  browser renders differs between browsers and changes under you.
- **Availability is answered by the daemon's host**, not by the browser you are reading the
  dashboard in - it is the daemon that launches the application. A target that cannot run
  there is greyed out with the reason attached ("not supported on win32 yet"), which is the
  difference between a broken button and a missing dependency.
- **Nothing about the checkout crosses HTTP.** The daemon launches a local application
  against a local path; it does not serve the bytes. Serving them would put
  checkout-controlled HTML on the daemon's own origin, where its scripts would reach every
  action route on the port.
- **Adding a target is a file and two entries.** `OPEN_TARGET_IDS` / `OPEN_TARGET_INFO`
  (`@shared/open-targets.ts`) say what a target is called and promises; an implementation
  under `src/server/open-targets/` says how to resolve and launch it. The menu is a fold
  over that list, so an editor or a JetBrains IDE needs no component, stylesheet or route
  change. Both records are `Record<OpenTargetId, …>`, so a declared target that nothing can
  launch does not compile.

## Message formatting

Agents write markdown, so the transcript renders it: headings, lists, tables, and fenced
code blocks with syntax highlighting drawn from the dashboard's own palette. The same
renderer draws shared plans and Foreman's briefs, so a fence looks the same wherever you
read it.

**Settings → Display → Format messages** turns it off, and the choice persists per
machine. Off shows the literal text an agent emitted, backticks and all - useful when
you're checking exactly what was said before pasting it somewhere that isn't a markdown
renderer. Formatting is display-only either way: it never changes what the agent wrote or
what gets sent when you reply, and copying a code block still yields exactly the
characters inside the fence.

Two deliberate limits. A fence with **no language tag is left uncoloured** rather than
guessed at - agents emit plenty of fences that aren't code (log tails, file trees, error
dumps), and a confident wrong guess reads worse than no colour. And **single newlines stay
line breaks** in chat turns, which is what the transcript did before it parsed markdown,
so no existing message reflows into a run-on paragraph.

Links in a formatted transcript that resolve inside that session's checkout open in the
same session's Files workspace. Console and Board reveal their integrated Files tab; Cards
reuse the extracted Files window. Checkout-relative links and absolute paths beneath the
checkout are accepted, including optional line and column suffixes. External links keep
their normal browser behavior, and resolved paths outside the checkout never open. HTML and
Markdown open in Preview by default, while ordinary text opens in the editor. HTML preview
remains inert: a bounded set of checkout-local stylesheets is inlined through the contained
file reader, without granting the sandbox scripts or network access.

## Tooltips

Every control in the dashboard says what it does on hover. Buttons, links, selects,
checkboxes, radios, disclosure rows, and the status chips whose text is clipped all carry a
tooltip; the ones bound to a shortcut name the key too, so the chord is learnable from the
control rather than only from the Keyboard panel.

They are one component (`src/web/components/Tooltip.tsx`) rather than the browser's `title`
attribute, which this replaced everywhere. `title` renders in OS chrome, so it was the one
surface in the app the theme could not reach; its delay is the platform's and not tunable;
and it never appears on keyboard focus, so half the fleet's controls described themselves
only to a mouse. The shared bubble matches the app's surface, border and shadow tokens,
opens on focus as well as hover, flips below the trigger near the top of the window, and
slides sideways to stay on screen at the edges - with its caret still pointing at the
control it belongs to.

Two details worth knowing:

- **Disabled controls keep their tooltip**, which is where it matters most - a dead Send
  says "No pane to send to" rather than leaving you to guess. Directly disabled triggers
  get a hover anchor; controls disabled by a fieldset put the hover target on their row.
- **Every label is also a real accessible description**, wired to its control with
  `aria-describedby`, so a screen reader reaches the same sentence a pointer does.

Free-text fields are deliberately left alone: they carry a visible label or placeholder
that is on screen the whole time, and repeating it on hover is noise. Anything you *act*
on has one, and `tooltip-coverage.test.ts` fails the build if a new control arrives
without one, or if a native `title` attribute creeps back in.

## Keyboard shortcuts

The dashboard is keyboard-driven - use the arrow keys to navigate Cards and Board, to walk
the Console rail or scroll its open reader, then act without reaching for the mouse. Every
shortcut works in every layout:

| Key | Action | Scope |
|-----|--------|-------|
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Around the grid in **Cards**; in **Console** and the **Board** drill-in <kbd>↑</kbd>/<kbd>↓</kbd> walk the rail selection, or scroll the reader's active tab once you <kbd>Tab</kbd> into it (and move through files while its inline Diff reader is focused); along and across the columns in the **Board** overview. With nothing selected, the first arrow selects the first session | Anywhere |
| <kbd>Tab</kbd> | **Console & board drill-in:** step into the open detail and one tab right each press - Conversation → Work queue → Gate → Diff → Files - clamping at the last rather than tabbing away. The reader takes a soft ring and <kbd>↑</kbd>/<kbd>↓</kbd> scroll whichever tab shows; <kbd>⇧</kbd><kbd>Tab</kbd> walks back, and from the conversation (or <kbd>Esc</kbd>) hands the keyboard to the rail | Open detail (Console or Board) |
| <kbd>Enter</kbd> | Open the selected session's detail (**Board** only - the other layouts open it with the selection). On a focused link or button it activates that instead, as it always does | Anywhere |
| <kbd>Esc</kbd> | Peel back exactly one layer per press - first close whatever's open on top of the grid (a panel, a dialog, the away digest), then leave a focused text box, then collapse an expanded card (**Cards**), hand a Console reader back to its rail, or leave the drill-in with the cursor still on it (**Board**), then deselect | Anywhere |
| <kbd>r</kbd> | Toggle the Roundup panel | Anywhere |
| <kbd>+</kbd> | Dispatch an agent | Anywhere |
| <kbd>/</kbd> | Focus the filter box (sessions, plus the board's backlog) | Anywhere |
| <kbd>⌘</kbd><kbd>K</kbd> | Open the settings search palette - from the fleet it jumps to Settings first, then opens; press again to close | Anywhere |
| <kbd>w</kbd> | Open the Workflows page, or press again to return to the fleet | Fleet or Workflows |
| <kbd>e</kbd> | Expand / collapse the selected session. **Cards**: focus-expands the card and drops the cursor in its reply box, ready to type. **Board**: opens (and closes) the drill-in detail, the same thing <kbd>Enter</kbd> opens. Console already shows the selected session expanded, so there is nothing to toggle | Selected session |
| <kbd>g</kbd> | Show the selected session's conversation. **Console / Board drill-in**: reveals the Conversation tab. **Board** overview: opens the drill-in, which starts there. **Cards**: expands the card, where the transcript already lives. Only ever reveals - <kbd>e</kbd> owns the toggle | Selected session |
| <kbd>d</kbd> | Open the selected session's diff (in the Console/Board Diff tab, or the Cards modal) | Selected session |
| <kbd>f</kbd> | Open Files for the expanded card or the selected Console/Board detail | Selected expanded/detail session |
| <kbd>⇧</kbd><kbd>O</kbd> | Search checkout files; use the arrows and Enter to open one in Files | Selected session |
| <kbd>s</kbd> | Send a message to the selected session (on an expanded card, jumps to the reply box already there) | Selected session |
| <kbd>t</kbd> | Open the **Terminal** launcher for the selected session's worktree. If its conversation is not visible, reveals it first, then opens the terminal chooser | Selected session |
| <kbd>a</kbd> | Open the selected session's **Codex / Claude** launcher: focus its existing terminal pane, or reveal the conversation and choose a terminal in which to resume it | Selected session |
| <kbd>p</kbd> | Focus the selected session's pane | Selected session |
| <kbd>⇧</kbd><kbd>P</kbd> | **Continue in terminal**: hand the selected Agent SDK session to a terminal, continuing the same conversation. One way, and does nothing on a session that already has a pane | Selected session |
| <kbd>q</kbd> | Show / hide the selected session's work queue | Selected session |
| <kbd>⇧</kbd><kbd>Tab</kbd> | In the reader (Console or board drill-in) walk one tab left, and from the conversation hand focus back to the rail. On the rail it cycles the permission mode (Claude only), as everywhere; on the **Board** overview it cycles the selected tile's mode in place without opening its detail | Selected session |
| <kbd>⇧</kbd><kbd>R</kbd> | Rename the selected session's terminal home | Selected session |
| <kbd>c</kbd> | Complete the selected session's task, optionally add an outcome note (blank records `completed`), then close the session; press <kbd>Enter</kbd> to confirm. Offers to unblock the tasks declared to wait on it, which is otherwise only possible by merging a PR | Selected session |
| <kbd>k</kbd> | Kill the selected session (press <kbd>Enter</kbd> to confirm) | Selected session |
| <kbd>⌃</kbd><kbd>R</kbd> | Reset the selected session's checkout to origin and clear its context, if its agent has a clear command (confirms first) | Selected session |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Move between Session, the stages, their reviewers and End. <kbd>Home</kbd> / <kbd>End</kbd> jump to either terminus | [Workflows](#workflows-and-personas) → Pipeline |
| <kbd>⌥</kbd><kbd>←</kbd> <kbd>⌥</kbd><kbd>→</kbd> | Move the focused stage earlier or later in the chain | [Workflows](#workflows-and-personas) → Pipeline |
| <kbd>⌥</kbd><kbd>↑</kbd> <kbd>⌥</kbd><kbd>↓</kbd> | Move the focused reviewer within its stage | [Workflows](#workflows-and-personas) → Pipeline |
| <kbd>Delete</kbd> | Remove the focused reviewer or stage, after a confirmation naming what goes | [Workflows](#workflows-and-personas) → Pipeline |

Every shortcut except the arrow keys, <kbd>Enter</kbd> and <kbd>Esc</kbd> is
**customizable**. Open **Settings** - the ⚙ gear in the top bar, or (in the desktop app)
**Mission Control → Settings…** / <kbd>⌘</kbd><kbd>,</kbd> - then click a shortcut and press the new key
(optionally with <kbd>⌘</kbd> / <kbd>⌃</kbd> / <kbd>⌥</kbd> / <kbd>⇧</kbd>). On a letter,
<kbd>⇧</kbd> counts as a modifier - <kbd>⇧</kbd><kbd>O</kbd> is a binding in its own right and
plain <kbd>o</kbd> does *not* trigger it. On a key that already shifts into another character
(<kbd>+</kbd>, <kbd>?</kbd>), just press that character. Bindings persist per machine, and
trying to reuse an assigned key is refused inline. You can reset any one shortcut (or all
of them); if another custom binding has claimed that shortcut's default, resetting clears
the override and leaves the shortcut unset until its default is free. The arrow keys,
<kbd>Enter</kbd>, <kbd>Esc</kbd> and bare <kbd>Tab</kbd> drive layout navigation and Console
reading, and can't be reassigned; <kbd>⇧</kbd><kbd>Tab</kbd> remains bindable. The pipeline
editor's four rows above are in-surface keys rather than fleet chords - they only exist
while a card in that strip has focus - so they are fixed for the same reason.

### Keycaps on the buttons

The buttons those shortcuts drive print the key on their own face - Terminal and
Codex / Claude in the conversation toolbar; Send, Focus, Files, Queue, Reset, Complete and
Kill on a card; Focus, Diff, Reset, Complete and Kill in the Console footer; the Console's
Conversation, Work queue, Diff and Files tabs; a card's `diff` pill; Dispatch and Workflows
in the top bar; and the settings rail's search box. They show the *resolved* chord, so a
rebind moves what they say and an unset action shows no keycap.

**Settings → Keyboard → Show keybindings on buttons** turns them off once you've learnt
them. Small icon-only controls (the ⚙ gear, the 📡 sitrep glyph, the expand chevron) never
carry one - a keycap would be larger than the icon - and name their key in the tooltip
instead. The command bar is unaffected either way: it is nothing but keycaps.

## Inspector (automated PR review)

The Inspector reviews the pull requests **Mission Control opened** - and only those -
against a repo-root `INSPECTOR.md`, leaves inline review comments for what it finds,
answers replies in its own threads, re-reviews on every push, and resolves its own
threads once a push fixes what they were about. When a live review finds nothing further
and every earlier Inspector finding is resolved, it leaves one top-level comment for that
head saying the pull request is safe to merge.

It ships **off**, in **dry run**, trusting **no repositories**. Turning it on is three
separate acts in Settings → Inspector, and the first two are reversible without anyone
else seeing anything. Enabling and mode live on the Inspector panel; which repos it may post
in is a column of **Settings → [Trust](#trust-who-may-act-in-which-repository)** now (the
panel shows the count and links there), the same list `mode` is checked against below.

### Only our pull requests

This is the whole consent model, so it is worth being precise about. Mission Control
learns about PRs two loose ways - a URL sniffed out of any `Bash` result, and
`gh pr list --head <branch>` - and neither can tell a PR you opened from one a colleague
opened on the same branch. Neither adopts anything.

A PR is adopted for review only from a signal that *proves* we opened it:

- the hook saw the agent run **`gh pr create`** (matched on the command, not the output -
  `gh pr view` prints the same URL), or
- **no-mistakes reported it itself**, in the `pr:` line of `axi status`, from the process
  that ran the `pr` step.

Adopted PRs are recorded durably and stay adopted while they are open, even after the
session that opened them exits. A PR with no adoption record is never touched. Adoption is
not consent to post - that is `mode` plus the allowlist - so a PR is recorded whenever the
proof arrives, including while the Inspector is switched off. That single local insert is
the only thing it does while off; it runs no `gh` and no model.

### Knowing its own comments

A comment counts as the Inspector's own only if **both** are true: it was written by the
login `gh` is authenticated as, **and** it carries a hidden marker
(`<!-- mission-inspector:v1 … -->`) at the very start of its body. That is what decides
which threads get resolved and which questions get answered.

Neither half is enough alone, for different reasons. The account is shared - you comment
under it, other agents run as you, a second Mission Control on another machine posts as
you - so the author cannot tell our comments from those; the marker can. And the marker's
prefix is a fixed public string whose fingerprints are visible in any PR's page source, so
anyone who can comment on the pull request can paste one; the author check is what stops a
forged comment being read as ours. If `gh` cannot say who we are, nothing counts as ours
and nothing is resolved or answered.

The marker must be at the *start* of a body to count. GitHub's quote-reply prefixes every
line with `> `, so a human quoting one of our comments would otherwise be mistaken for us
and never answered.

### What it can read, and why that is a trade

On Claude, the reviewer runs `claude -p` with **`Read`, `Grep`, `Glob`** in the reviewed
worktree. Reviewing a diff without being able to open a file misses most of what matters -
whether a change breaks a caller three files away, whether there is a test - so the grant is
deliberate. It also means a pull request diff (which anyone can author) reaches a model
that can read the filesystem, whose output is published publicly.

Five things stand in the way of that:

1. **Tool allowlist** - reading only. No `Bash`, no `Write`/`Edit`, no `WebFetch`, no MCP.
2. **Path deny rules** handed to Claude Code itself, covering `.env*`, keys, `.ssh`,
   `.aws`, `.git/config`, and Mission Control's own state - denied for all three of
   `Read`, `Grep` and `Glob`, since `Grep` prints the lines of any path it is given.
3. **Working directory** is the reviewed worktree; under `-p` a read outside it has nobody
   to approve it, so it fails.
4. **Every finding must name a file the PR changed.** One that doesn't is discarded - so
   "read a secret and repeat it" produces a comment with nowhere to land.
5. **A secret scrubber** on every outbound string, including the review summary, which is
   the one output rule 4 does not constrain.

**On Codex there is no grant at all, and the Inspector says so rather than pretending.**
The five constraints above are enforced by the provider, not asked for in the prompt, and
`codex exec` cannot express this exact per-tool deny list. Rather than accept a weaker
grant under the same name, the runner declares it can sandbox none, and the Inspector hands
it no tools: a Codex review reads the diff in the prompt and nothing else. That is a
narrower review - it cannot go and check the caller three files away - and it is the
honest version of the trade, which is why the panel prints it beside the provider picker.

It never approves or requests changes; it comments. It does not chase comments to
resolution - it surfaces issues and resolves what later pushes fix.

### INSPECTOR.md

Put one at the repo root. It tells the Inspector what the project cares about and, as
importantly, what not to comment on - an automated reviewer that pattern-matches style
nits is worse than none. This repo's own is [`INSPECTOR.md`](INSPECTOR.md). A repo without
one is reviewed against a built-in default brief instead - general engineering judgement,
with the same insistence on a low noise floor - so the Inspector still works on a repo
nobody has configured. It's read fresh each round, so editing it changes the next review.

The repo's `CLAUDE.md` / `AGENTS.md` are loaded alongside it, so the Inspector judges a PR
against the contract the repo actually asserts.

### On the card

A session whose pull request has been adopted grows a `⌕` chip beside its PR chip, and the
mark next to the glyph is where the review stands: no mark at all means adopted but not
looked at yet, `✓` means reviewed with nothing outstanding, a number is the count of open
findings, and `!` means the last round didn't complete. It's a mark rather than a word
because a word costs the card title the width it needs; the sentence is in the tooltip. In
`dry-run` the chip is set apart - a dashed border, a dotted underline in the rail - and the
tooltip says nothing was posted.

Cards, board tiles and the console detail all carry it, and there it opens the pull
request. The console rail carries the same mark without the link, and only when there is
something to say - open findings or a failed round - because a rail line is scanned rather
than read.

### The review model

**Settings → Inspector → Model** names what the review and the follow-up replies spawn as,
and the **Provider** row above it names the CLI they spawn through. It ships as
`claude-sonnet-5` on the `claude` provider, and the field's own line tells you where the
value in force came from - your config, `MISSION_INSPECTOR_MODEL` in the daemon's
environment, or the shipped default. Leave it empty to accept whichever of the other two
applies. The Inspector keeps its own provider choice rather than following the app-wide
one, because [what it can read](#what-it-can-read-and-why-that-is-a-trade) changes with it.

Naming a default at all is the point. An unset `--model` inherits whatever the local
`claude` CLI happens to default to - on one machine that resolved to the 1M-context Opus
tier at roughly $2 a round - and nothing in the app recorded it or could show it to you.

A model is a **cost** choice here, not a latency one. The same 10KB PR measured 225s on
Opus and 272s on Sonnet: the cheaper model read more files to reach the same verdict. See
`MISSION_INSPECTOR_TIMEOUT_MS` for the ceiling those numbers set.

### Dry run

`dry-run` does everything except post: it adopts, reviews, computes findings and dedupes
them, then records them instead of publishing. **Settings → Inspector → Inspections** is
where you read what it would have said. Run it there on a few of your own PRs before you
let it speak.

Each row says where that PR stands: `queued` (adopted, not yet looked at), `failed` (the
last round errored - hover the link for why), a finding count, or `clean`, beside a count
of the findings a later push has since fixed. A PR that has since closed reads `merged` or
`closed` and is dimmed: it left the sweep for good, so it is history rather than a queue. A
closed PR that *was* reviewed keeps its findings, because what the Inspector said about
something that landed is the more useful fact.

The count strip above the table tallies those same states and filters to one when you click
it - on a ledger that is mostly landed work, *with findings* is how you get to the two rows
that need you. The **Health** card beside it reports the last completed review and the last
failure, which is the difference between an Inspector that is quiet and one that has been
erroring for three hours; in the list those look identical, because every row simply keeps
its last verdict.

## Shipping (YOLO mode)

**Settings → Shipping** is where you decide what lands without you. **YOLO mode** merges
the pull requests Mission Control opened - the same adopted set the Inspector reviews, and
only those.

It ships **off**, trusting **no repositories**, with a **10 minute** soak.

### What has to be true

Every one of these, on the same read of the pull request:

| Gate | Why |
|---|---|
| The Inspector reviewed **this** push | a review of the previous head is not a review of what would land |
| The Inspector **published** that review | on, **live**, and the repo on *its* allowlist - see below |
| No active Inspector-gated workflow owns the PR | YOLO mode cannot merge around incomplete Personas or final-gate handling |
| No open Inspector findings | posted or previewed in dry run - a finding is a finding |
| No unresolved review threads | stricter than the above on purpose: not merging over a colleague's unanswered question, whoever asked it |
| Nobody requested changes, no required review outstanding | a human veto outranks a clean automated review |
| **CI passing** on the head commit | a commit with **no** checks does not pass this: it has never been asked |
| GitHub says it merges cleanly | `CONFLICTING` blocks, and so does mergeability it has not computed yet |
| Open for the **soak** | the window in which somebody can look and say no |
| The repo holds the **merge grant** | its own column in [Trust](#trust-who-may-act-in-which-repository), not the Inspector's |

The soak is measured from when the pull request was opened, and defaults to 10 minutes.
Zero means "merge as soon as everything else passes". A push resets the review gate rather
than the soak - the new head has to be reviewed clean before anything merges.

The merge itself is a compare-and-swap against the head that was evaluated, so a push
landing in the seconds between the decision and the call makes GitHub refuse rather than
merge code nothing has looked at. Squash by default; merge commit and rebase are the other
two options.

The workflow veto is narrow and can only block. Inspector remains the sole PR poller and the
sole GitHub merge path. An active published Inspector gate vetoes its adopted or candidate PR;
completed, cancelled, archived, and no-final-gate workflows do not.

### It needs the Inspector, fully on

YOLO mode rides the Inspector's poll and merges what the Inspector reviewed clean, so with
the Inspector switched **off** nothing is ever reviewed, nothing qualifies, and nothing
merges. It is not a way to merge unreviewed pull requests.

All **three** of the Inspector's switches count, not just the first, because a review it
never published is not a review anything may act on:

| Inspector state | YOLO mode |
|---|---|
| **off** | nothing is reviewed, so nothing merges |
| on, but **dry run** | it reviews and publishes nothing - no merge |
| on and live, repo **not on the Inspector's allowlist** | same: it reviews, publishes nothing - no merge |
| on, live, repo on **both** allowlists | the gates above decide |

The middle two are worth stating plainly because they are not obvious: dry run still
*reviews*, and it advances the reviewed head exactly as a live round does. Only the
publishing stops. So "the Inspector reviewed this push" is true in dry run, and it is not
sufficient - **dry run means dry for the merge too**. While YOLO mode is armed, Shipping's
**Prerequisites** card names whichever of the three is in the way and links to the control
that fixes it; each reason also appears per pull request in the *Merge queue*. The card
says so only while something is genuinely unmet - a checklist of green ticks is one nobody
reads on the day a tick turns red.

Switching from dry run to live does not promote the review that already ran. The reviewed
head records the Inspector posture that produced it; once live, the Inspector reviews that
same head again, and only the new live result can authorize a later merge. Rows created by
an older build have no recorded posture and fail closed through the same re-review path.

The two allowlists stay separate: letting the Inspector comment on a repo is a smaller
grant than letting it merge there, so a repo has to be on both. Shipping's list does not
stand in for the Inspector's. Both are columns of
**Settings → [Trust](#trust-who-may-act-in-which-repository)** now (the Shipping panel shows
the merge count and links there); the separation is exactly why Trust draws them as two
columns and flags the one dangerous combination - merge granted, review not - in amber.

### Why it did not merge

An auto-merger's failure mode is merging nothing and never saying why, so **Settings →
Shipping → Merge queue** carries the current reason per PR: soaking, CI still running,
three open findings, not on the allowlist. *Soaking* is its own tile in the strip rather
than part of *held at a gate*, because it is the one block that clears itself - counting it
as an obstruction is how the safety valve ends up turned down to zero. When GitHub refuses the merge
outright - a branch protection rule this app cannot see - its own message is shown there
verbatim, because that is the only account you get of a rule nothing here can read.

### When a task's pull request merges

A task whose pull request merged ends as **done**, with that pull request as its outcome,
instead of as `failed`. This is **not tied to YOLO mode** - a pull request you merged
yourself on GitHub lands its task exactly the same way.

It matters because `failed` means "ended with no outcome recorded", and a failed task
reports as a *stopped* blocker - so every task declared to wait on it deadlocks behind
work that actually shipped. A task left unsettled costs more than a stale row, too: a live
session counts against the `maxSessions` ceiling, *and* the backlog autopilot refuses to
hand work to an agent that still has a non-terminal task bound to it, so a finished agent
both occupies a slot and is ineligible to use it.

**The merge alone does not end the task.** An agent routinely lands an intermediate pull
request and carries on, and you might merge, read the diff for a minute, and only then
tell it to continue - so no delay after the merge is long enough to rule more work out.
The merge is recorded when it happens, and the task is first concluded once its agent
**appears to have finished the episode**: idle, nothing queued, and not rolled onto new
work. An agent that is mid-turn is left alone whatever its pull request did.

Once the agent is **gone for good**, though, any pull request it merged is its outcome -
including one on an episode it had already rolled past. The two cases differ because a
present agent may still be mid-turn: while it is here, a rollover means it was handed more
work, so the merge is not concluded yet (above). But a departed agent has no work in flight
to strand, and reporting a pull request that actually shipped as `failed` would deadlock
every task waiting on it behind a *stopped* blocker. The merge survives the rollover in the
task's durable record, so a later prompt cannot outrun it; if several of the agent's
episodes merged, the **most recent** merge is the one recorded.

An idle agent cannot tell you whether it is finished or merely waiting to be typed at, so
that conclusion is **reversible**: if you send a follow-up prompt, the task goes back to
running and drops the outcome. Only conclusions Mission Control drew from idleness are
undone this way - an outcome you recorded yourself is never overwritten. This correction
is deliberately limited to the current daemon run; after a restart, a completed task
stays done.

#### A merge that lands when nobody is watching

Neither of those two moments is guaranteed to arrive. An agent killed while the daemon was
down is never seen being evicted, and a pull request you merge days later belongs to a
session that no longer exists - so the merge had no observer at all, and the task sat
`running` or `failed` for as long as you left it there.

So while its row is still present in Mission Control, a task's own pull requests are
**polled by URL** for as long as its completion is still in question, alongside the ones a
declared dependency is waiting on and at the same rate. No session needs to exist. When one
of them merges, the task is completed from the durable record - and that includes rows that
had already been written off:

| Status when the merge is observed | What happens |
|---|---|
| `running`, `dispatching`, agent gone | **done**, with the pull request as its outcome |
| `running`, `dispatching`, agent still here | nothing yet - the narrower rule above owns it, because the agent may be mid-turn |
| `failed`, `cancelled` | **upgraded to done**: the error is cleared and the pull request becomes the outcome |
| `done` | untouched - your outcome is never overwritten |
| `backlog` | untouched: a rescheduled task is being re-run, so its previous attempt's merge is not this run's result |

Only a **merged** pull request does this. One that was closed without merging changes
nothing, and neither does one still open. An upgrade records an outcome and nothing else:
the worktree, branch and any terminal home stay exactly where they were, still behind the
**Clean up** button, because freeing a checkout runs `git worktree remove --force` and
stays a human's click. Tasks that declared a dependency on the upgraded one are released
at the same moment, which is the point - a `stopped` blocker over work that shipped is
what stalls a backlog.

Unlike the idle conclusion, this one is **not reversible**: it was drawn from a pull
request in main, not from an agent that had gone quiet, so an agent typing again does not
reopen it.

What happens to the agent is yours to choose, in **Settings → Shipping**:

| Close the session after merge | What happens |
|---|---|
| **off** (default) | The agent stays, with its checkout and its context. Once idle, its merged task lands; a later follow-up reopens it |
| **on** | If the agent is idle with an empty queue when the merge is observed, Mission Control first marks the task done and then closes its session, freeing a fleet slot for a fresh dispatch. Its worktree is reclaimed **only** when nothing would be lost - uncommitted or untracked files keep the checkout, and the task row keeps its **Clean up** button |

An agent that is still **working**, awaiting input, awaiting review, or carrying queued
work is neither closed nor failed as a substitute for completion, even with the switch
on. The merge is recorded either way, so its task lands correctly whenever the episode
does finish.

The reclaim is conditional on purpose: a merge proves the *committed* work landed and says
nothing about files still sitting unsaved in that checkout, and reclaiming runs
`git worktree remove --force`. Anything that could be lost stays behind a human click.

## no-mistakes

The design is inspired by [`kunchenguid/no-mistakes`](https://github.com/kunchenguid/no-mistakes)
(a git-push gate with a daemon + approval channel). This harness reuses that
shape - long-lived daemon, event stream, agent-report/approval channel - and
runs no-mistakes as a **component**.

If `no-mistakes` is installed and a session's repo is gated, the card surfaces
the live run: a `◇ gated` chip plus a strip showing the pipeline
(intent → review → test → … → ci as status dots), the active stage it's on
(e.g. `review · step 3 of 9 · 1 finding so far`), what that stage last did in
no-mistakes' own words (`↳ 2m43s ago: log: all CI checks passed - still
monitoring until merged or closed`), a running findings summary in
the header, the gate it's parked at, and the findings - all polled via
`no-mistakes axi status` (its TOON agent interface).

That last-activity line is there because a dot only carries a *status*, and
"running" is the same word for a step mid-work and a `ci` step that went green an
hour ago and is now just watching an open PR. A run that has pushed, opened its PR
and passed CI sits on a blue `ci` dot until the PR is **merged or closed** - which
is correct, and looks broken. The step says as much itself; the strip quotes it
rather than guessing. It quotes and nothing more: a step reported quiet is idling
between polls, not stuck (`ci` naps for hours, then completes the moment the PR
merges), and `agent_pid` is empty even for a healthy monitor - so neither is read
as a verdict on a run's health.

A separate live narration
line echoes what the skill is doing right now, read from the in-progress to-do in
the session's Claude transcript. The active-stage, summary, and narration lines
step aside while a run is parked, where the gate line already conveys that state.
When a run is parked at a gate you can **approve / fix / skip** it right there;
those map to `no-mistakes axi respond --action …` (fix lets you pick findings and
add guidance). Approve and skip confirm first since they advance the pipeline
toward pushing your branch. Once the dashboard accepts a response, the actions give
way to its submission status while the blocking command runs. If that command fails,
the strip shows its diagnostic and leaves the gate retryable. When the next gate arrives
before the session's terminal has caught up, the strip labels the earlier response and
distinguishes the new findings as a later round or pipeline step.
[Foreman](#foreman-auto-responder), if enabled, can take
the first look at a parked gate for you: it reads the finding the run relayed and
either answers it or escalates it as a decision brief, rather than leaving the run
parked until you get to it.

Resetting a checkout (the card's **reset** control, <kbd>⌃</kbd><kbd>R</kbd>) also
**retires the run the card was showing**, clearing the strip and its narration for
good. The reset throws away the very work that run validated, but `axi status` keeps
reporting it for that branch long after, so simply clearing the strip wouldn't hold:
the next poll would put it straight back. The dismissal is remembered per run, so a **new** run on the same
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
sessions and tracked tasks, plus every checkout under `MISSION_WORKSPACE_DIRS` -
each `MISSION_POOL_REAP_MS`, and again whenever a dispatch finds the pool dry. The
workspace scan is what reaches a *fully* leaked repo: once its agents are gone
there is no live session left to advertise it, and you can't start one to fix
that, because `treehouse get` is precisely what fails when the pool is dry.

It hands back only the leases it can prove are dead, and only its **own**. A tree
is returned **only** when it is leased to `mission-control` (the holder both `make
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
other one it walks. Reclaiming a `mission-control` lease is only fair game because
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

Set `MISSION_POOL_REAP_MS=0` to switch the background sweep off entirely; the
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
| `MISSION_PORT` | `7317` | daemon / dashboard port |
| `MISSION_HOME` | `~/.mission-control` | state dir (db, token, logs, dispatch worktrees) |
| `MISSION_WORKSPACE_DIRS` | `~/workspace` | colon-separated roots scanned for the dispatch repo picker, and for the treehouse pools the leaked-lease sweep visits |
| `MISSION_POLL_MS` | `1500` | discovery interval |
| `MISSION_AGENTS_SHADOW_MS` | `0` (off) | how often to take a [shadow reading](#shadow-reading-claudes-own-session-state) of `claude agents --json` and log where it disagrees with our own discovery. Diagnostic only - it never feeds the registry. `0` or any non-positive value disables it; anything under `5000` is clamped up, since one reading spawns the full `claude` binary |
| `MISSION_NM_POLL_MS` | `5000` | no-mistakes status interval |
| `MISSION_POOL_REAP_MS` | `300000` | how often to sweep treehouse pools for leaked leases. `0` (or any non-positive value) turns the background sweep off; an unparseable value falls back to the default; anything under `30000` is clamped up to it, and anything over `604800000` (7d) clamped down to it, since past ~24.8d `setTimeout` overflows into a hot loop |
| `MISSION_DISPATCH_READY_MS` | `30000` | dispatch: how long to wait for the agent's pane to be discovered before failing |
| `MISSION_DISPATCH_SETTLE_MS` | `2000` | terminal-runtime dispatch: how long a discovered pane with no usable hook readiness signal must remain live before dispatch continues. This starts immediately for Pi, whose positional launch message needs no pane injection, and after a hook wait times out for a still-live session. An observed exit fails instead. Agent SDK dispatch does not use a settle delay |
| `MISSION_DISPATCH_HOOK_READY_MS` | `20000` | terminal-runtime dispatch: how long to wait for the exact discovered session's first hook when that launch can produce one. Hook silence falls back to the settle above if the session is still live; an observed exit ends the wait immediately. The wait is skipped for hookless harnesses such as Pi and when a particular Codex launch could not install its [hook bridge](#precise-status-for-codex-hooks-that-ride-on-the-dispatch) |
| `MISSION_TASK_TITLE_MODEL` | `claude-haiku-4-5` | [dispatch](#dispatch-an-agent): the model that names a task whose Title was left blank. **Settings → Models → Task title** wins where it is set, then this, then the shipped default |
| `MISSION_WORKFLOW_CONTEXT_MODEL` | provider's cheap model | [Workflows](#workflows-and-personas): compacts one Preview submission's preserved raw evidence, with one fresh 45-second attempt after an unparsable reply and deterministic fallback on failure. **Settings → Models → Workflow context** wins where it is set, then this, then the selected provider's cheap default |
| `MISSION_WORKFLOW_PERSONA_MODEL` | provider's balanced model | [Personas](#workflows-and-personas): runs a fresh, tool-less Persona review. A Persona's own model override wins, then this variable, then the selected provider's balanced default |
| `MISSION_ENSEMBLE_COMPARISON_MODEL` | provider's cheap model | [Ensembles](#multi-agent-ensembles): the model behind every ensemble evaluation - the Best-of-N comparison, the Consensus divergence pass, and each Panel-vote judge's ballot. An explicit evaluator or judge model wins, then a judging Persona's model override; otherwise **Settings → Models → Ensemble evaluation**, then this variable, then the provider's cheap default |
| `MISSION_TASK_TITLE_TIMEOUT_MS` | `15000` | dispatch: hard cap on one titling attempt - a timeout isn't retried, so a missing or slow `claude` costs this once and the first-line title stands. Sized above Haiku's measured 7-8s; a successful call returns as soon as the model does, so lowering it only buys a faster failure |
| `MISSION_LLM_RUNNER` | `claude` | [Models](#models-what-the-apps-own-model-work-runs-on): which provider does the app's own offline work - the background jobs, Foreman's cheap tier. **Settings → Models → Provider** loses to this where it is set, and the panel says so. An id this build does not have falls back to the default rather than failing, and the panel names what it dropped |
| `MISSION_SKILLS_DIR` | app's `skills/` | [skills](#skills-every-session-mixed-reload-behavior) catalog dir (the symlinks' target) |
| `MISSION_FOREMAN_INSTRUCTIONS` | app's `FOREMAN.md` | the seed for [Foreman's standing instructions](#its-standing-instructions-foremanmd). Only the DEFAULT - once saved through the API the stored value wins, and this is what a reset restores |
| `MISSION_MCP_SERVER` | app's `dist/mcp/server.mjs` | path to the bundled MCP server that dispatched sessions are pointed at through [the ask channel](#the-ask-channel)'s `--mcp-config`. If the path doesn't exist the channel is skipped entirely and the session keeps Claude's built-in menu |
| `MISSION_TASK_SOURCE_TICK_MS` | `30000` | [Task sources](#task-sources-pulling-work-into-the-backlog): how often the sweeper wakes to ask which sources are due. Not the sweep interval - that is per source, and clamped to 1 minute - 24 hours. Floored at `5000` |
| `MISSION_TASK_SOURCE_TIMEOUT_MS` | `60000` | Task sources: hard cap on one sweep, so a hung source cannot wedge its own schedule. Floored at `5000` |
| `MISSION_SKILLS_SETTLE_MS` | `10000` | skills: how long a session must sit idle before the daemon types `/reload-skills` into it |
| `CLAUDE_SKILLS_DIR` | `~/.claude/skills` | skills: where Claude's symlinks are written; set, it wins outright. Overridable so tests never touch your real one. Left unset, a daemon on an explicit `MISSION_HOME` writes to `<MISSION_HOME>/claude-skills` instead - it doesn't own the machine's shared dir, and reconciling that dir against an isolated daemon's own (empty) skills config would unlink the real install's links |
| `CODEX_SKILLS_DIR` | `~/.agents/skills` | the same override for Codex's skills directory; on an explicit `MISSION_HOME` it falls back to `<MISSION_HOME>/codex-skills`, for the same reason. Point both at one path and the reconciler still walks it once |
| `PI_SKILLS_DIR` | `~/.pi/agent/skills` | the same override for Pi's skills directory; on an explicit `MISSION_HOME` it falls back to `<MISSION_HOME>/pi-skills`. Pi loads SKILL.md skills from the same standard as Claude and Codex, so the reconciler links the catalog into this dir too. Identity-bound Pi sessions dispatched by Mission Control receive `/reload` when idle; operator-started Pi sessions need a launch or restart |
| `MISSION_CLAUDE_BIN` | `claude` | Claude CLI path override - both for dispatched agents and for every headless `claude -p` the app runs (Foreman's review and Tier 1 router, the [Goal](#goal) refiner, the untitled-[dispatch](#dispatch-an-agent) titler, the [Inspector](#inspector-automated-pr-review)'s review and reply) |
| `MISSION_CLAUDE_TIMEOUT_MS` | `120000` | default hard cap on a single headless `claude -p`; callers that set their own budget (the Tier 1 router, the Goal refiner, the dispatch titler, the Inspector - see `MISSION_INSPECTOR_TIMEOUT_MS`) pass it instead |
| `MISSION_INSPECTOR_POLL_MS` | `90000` | [Inspector](#inspector-automated-pr-review): how often to look at the adopted PRs. Slow by design - a review is expensive and a push isn't frequent. Also the base of the retry backoff: a PR that keeps failing is retried at twice the previous delay, up to six hours. A new push cuts that wait short for the first few failures, after which it waits like any other attempt - unless the failure is one only a push can fix (a diff too large to buffer), where the next push always cuts it short. The tick does nothing at all while the Inspector is off |
| `MISSION_INSPECTOR_MODEL` | `claude-sonnet-5` | Inspector: the model both the review and the follow-up replies run on. **Settings → Inspector → Model** wins where it is set, then this, then the shipped default. Named rather than left to the `claude` CLI: an unset `--model` inherits whatever that CLI defaults to, which is the priciest tier available and is not recorded anywhere |
| `MISSION_INSPECTOR_TIMEOUT_MS` | `600000` | Inspector: hard cap on one review. Far larger than the Foreman reviewer's 120s because this one has tool round-trips inside it: a 10KB five-file diff measured 225s on Opus and 272s on Sonnet, so a wire near either is a guaranteed failure rather than a safety net - the run is killed, the head never advances, and the PR climbs the retry backoff having produced nothing |
| `MISSION_INSPECTOR_REPLY_TIMEOUT_MS` | `300000` | Inspector: hard cap on one follow-up reply - a smaller job than a review, but the same shape (the diff in the prompt, the same read-only tools), so it moves with the review's ceiling rather than sitting at a fraction of it |
| `MISSION_INSPECTOR_MAX_DIFF_BYTES` | `400000` | Inspector: cap on the diff put in a prompt. A refactor past this isn't reviewable in one pass anyway; the prompt says it was truncated so the model never concludes anything from the absence. Separately, a diff too large to hold in memory at all (16MB) is declined rather than reviewed - the PR is parked, and a later push that shrinks it below the ceiling gets reviewed |
| `MISSION_CODEX_BIN` | `codex` | Codex CLI path override - both for dispatched agents and for every headless `codex exec` the app runs when Codex is the selected [provider](#models-what-the-apps-own-model-work-runs-on) |
| `MISSION_CODEX_TIMEOUT_MS` | `120000` | hard cap on a single headless `codex exec`, the mirror of `MISSION_CLAUDE_TIMEOUT_MS`. A caller that sets its own budget (the Inspector, the Goal refiner, the dispatch titler) passes it instead |
| `MISSION_PI_BIN` | `pi` | Pi (`@earendil-works/pi-coding-agent`) CLI path override for dispatched agents. Pi is a discovered/dispatched harness, not one of the app's own headless model providers |
| `MISSION_CODEX_HOOK` | app's `dist/satellites/codex-hook.mjs` | path to the bundled [Codex hook bridge](#precise-status-for-codex-hooks-that-ride-on-the-dispatch) the dispatcher points a Codex launch at. If the path doesn't exist the hook overrides are dropped entirely and the session runs uninstrumented rather than failing to launch |
| `WEZTERM_BIN` | auto | wezterm CLI path override |
| `GHOSTTY_BIN` | `/Applications/Ghostty.app/Contents/MacOS/ghostty` | [Ghostty](#which-terminal-you-use-is-declared-not-assumed) path override, for a non-standard install location. It answers *is Ghostty installed* and is never executed - the app drives the GUI through AppleScript, not this binary. There is deliberately no bare `ghostty` on `PATH` fallback: on Linux that binary is normally present and this integration cannot work there at all, so it would report "installed" on the one platform where every call must fail |
| `CMUX_BIN` | auto | cmux CLI path override. The default looks inside the app bundle (`/Applications/cmux.app/Contents/Resources/bin/cmux`) before PATH, because the cask does not symlink it |
| `NOMISTAKES_BIN` | auto | no-mistakes CLI path override |
| `FOREMAN_CLAUDE_BIN` | `claude` | legacy alias for `MISSION_CLAUDE_BIN`, still honored so existing setups keep working - and honored for the same things, dispatched agents included, since both now resolve through one chain; `MISSION_CLAUDE_BIN` wins when both are set |
| `FOREMAN_REVIEW_TIMEOUT_MS` | `120000` | Foreman: hard cap on one session review before it's abandoned - and the legacy alias for `MISSION_CLAUDE_TIMEOUT_MS`, which wins when both are set |
| `FOREMAN_EVAL_DEBOUNCE_MS` | `60000` | Foreman: minimum wall-clock gap between evaluations of the same session |
| `FOREMAN_REVIEW_MODEL` | `claude-opus-5` | Foreman [models](#which-model-foreman-runs-as): the full reviewer (the `reviewModel` config wins over this) |
| `FOREMAN_VERIFY_MODEL` | `claude-opus-5` | Foreman [models](#which-model-foreman-runs-as): the work-queue verifier (the `verifyModel` config wins over this) |
| `FOREMAN_TRIAGE_MODEL` | `claude-haiku-4-5` | Foreman [cheap tier](#the-cheap-tier): Tier 1 router model (the `triageModel` config wins over this) |
| `FOREMAN_TRIAGE_TIMEOUT_MS` | `30000` | Foreman cheap tier: hard cap on the Tier 1 router; a timeout just routes up to the full review |
| `FOREMAN_BACKLOG_MODEL` | `claude-sonnet-5` | [Backlog autopilot](#backlog-autopilot-foreman-schedules-the-fleet): the model that reads the backlog's dependencies (the `backlogModel` config wins over this) |
| `FOREMAN_BACKLOG_TIMEOUT_MS` | scales with the backlog | Backlog autopilot: hard cap on one dependency read. Unset, the budget is `60s + 20s` per backlog item, capped at 10 min - the reply carries one written entry per task, so a fixed cap silently stops working once the backlog outgrows it. Set it to pin a flat ceiling instead. Three failures in a row and Foreman schedules serially |
| `FOREMAN_BACKLOG_RETRY_MS` | `600000` | Backlog autopilot: how long serial mode lasts before the dependency read is retried, so a transient outage doesn't degrade scheduling until a restart |
| `FOREMAN_BACKLOG_STORE_BACKOFF_MS` | `15000` | Backlog autopilot: first wait after the daemon refuses to store a plan, doubling per consecutive failure up to 10 min - a broken route can't cost a model call per tick, and after three it schedules one task at a time rather than stopping |
| `FOREMAN_QUEUE_SETTLE_MS` | `10000` | how long a session must sit idle before its work counts as settled - shared by the work queue's verify step, the PR follow-up, and the backlog autopilot's "is this agent free?" test |
| `MISSION_GOAL_MODEL` | `claude-haiku-4-5` | [Goal](#goal): the model that rewrites a prompt into the card's sentence. **Settings → Models → Goal** wins where it is set, then this, then the shipped default |
| `MISSION_AWAY_POLL_MS` | `5000` | [Away mode](#away-mode): how often the daemon re-checks for stuck sessions |
| `MISSION_AWAY_DIGEST_MODEL` | `claude-haiku-4-5` | [Away mode](#away-mode): the model that writes the return digest's narrative. **Settings → Models → Away digest** wins where it is set, then this, then the shipped default |
| `MISSION_AWAY_DIGEST_TIMEOUT_MS` | `20000` | Away mode: hard cap on the digest call; on a timeout the deterministic rollup stands alone |
| `CLAUDE_SETTINGS_PATH` | `~/.claude/settings.json` | which settings file the hook / statusLine / [cost telemetry](#cost-telemetry) installers edit. Overridable so tests never touch your real one |

**Your dashboard settings are stored per machine, not per browser.** Layout, keyboard
shortcuts, alert delivery, message formatting, and the usage row's fold all live in the
daemon's database (`app_config`), alongside the Foreman, Skills, Harnesses, Task sources, Models, and
Cost settings - so they are the same in every tab, on `localhost` and `127.0.0.1` alike, in the
desktop app and in a browser, and they survive an upgrade. The browser keeps a copy in
`localStorage`, but only as a cache so the dashboard paints your layout in the first
frame; deleting it costs one request, not a preference.

[Cost telemetry](#cost-telemetry) is not configured by the environment - it is a switch in
**Settings → Cost** (or `npm run install-telemetry`), which writes these keys into your
`~/.claude/settings.json` `env` block so that every Claude Code session on the machine
inherits them, including ones this app never launched:

| Key | Written as | Meaning |
|-----|-----|---------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` | turns Claude Code's own metrics on |
| `OTEL_METRICS_EXPORTER` | `otlp` | export over OTLP |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` | JSON, so the daemon takes no protobuf dependency |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:<MISSION_PORT>` | the daemon; the SDK appends `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `x-harness-token=…` | the same per-machine token the hooks present |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | how often each session reports, in ms (5s-60s, set in Settings) |

`OTEL_METRICS_INCLUDE_SESSION_ID` is deliberately **not** written: it defaults to true and
must stay true, because with it false every datapoint arrives with no session id and none
of it can be attributed. If you have set it to `false` yourself, the daemon says so at
startup and the Cost panel says so on screen.

> **Upgrading from Fleet Control (`FLEET_*`) or ai-harness (`HARNESS_*`)?** Nothing to do.
> Both older env prefixes are still honored as fallbacks - `MISSION_*` wins where more than
> one is set - so a hook or MCP server installed under an older name keeps reporting without
> being reinstalled. On its first start the daemon renames an existing `~/.fleet-control`
> (or `~/.ai-harness`) state dir to `~/.mission-control`, keeping your db, token, and
> uploads; if that move can't happen the old dir keeps working exactly as before. Treehouse
> leases stamped with the old holder names are still recognised as ours, so a renamed
> install doesn't strand its worktree pool. Prefer the `MISSION_*` names going forward.
>
> Dashboard settings (layout, shortcuts, alerts, formatting) are read out of the browser
> once, under whichever product name last wrote them, and saved into the daemon - after
> which the rename can't reach them again. This only runs when the daemon has no settings
> of its own, so it can never overwrite ones you are already using. Settings left behind by
> an older **desktop app** are the exception: renaming the app gave it a new Electron
> profile, and the new one cannot read the old one's storage.
>
> Two things do need a re-run, because they registered a name with something outside this
> repo: `npm run install-service` (the launchd label becomes `com.mission-control.daemon`;
> the installer unloads the old one for you) and, if you use the review channel,
> re-adding the MCP server under its new name (`claude mcp add -s user mission-control …`).

## Commands

```sh
make init              # one-time bootstrap (deps, build, hooks, treehouse + no-mistakes)
make session           # start an agent in a fresh, gated worktree
npm run dev            # daemon + web (dev)
npm start              # daemon serving built UI
npm run foreman        # Foreman worker (needs-you queue, work queues, PR follow-up, backlog autopilot)
npm run build          # build web + MCP bundle
npm test               # unit tests (detection, correlation, hook mapping, dispatch, report, alerts, stalls, away mode, foreman, skills)
npm run smoke          # boot the built bundles and check they actually run (after build)
npm run typecheck      # tsc --noEmit
npm run install-hooks  # wire Claude hooks
npm run install-statusline # + wrap the status line (terminal model / thinking / context %, plan meters)
npm run install-telemetry  # + cost telemetry env block (see Cost telemetry)
npm run install-service# LaunchAgent (macOS)
npm run personas       # recompile the built-in Personas from docs/personas/*.md (commit the result)
node scripts/codex-app-server-bindings.mjs  # regenerate app-server types from the installed Codex
```

## Security

The daemon binds to loopback only, and every data endpoint (`/api/*`, `/events`)
additionally requires a loopback `Host` header so a web page you visit can't reach
it via DNS-rebinding - a defense that matters now that dispatch can launch agents
(effectively RCE) and reads leak task prompts, repo paths, and transcripts. Hook,
statusLine, OTLP metrics (`/v1/metrics`) and MCP ingress are authenticated with a
per-machine token in `~/.mission-control/token` so other local processes can't spoof
session, task, or cost-estimate state. Cost datapoints arrive carrying `user.email`,
`user.account_uuid`, `user.account_id` and `organization.id`; the ingest reads four
attributes and discards the rest before anything is written, so none of it reaches the
database. Session and task
actions (send / rename / focus / kill, dispatch / cancel / complete) are localhost-only.

Two subsystems act outside this machine, and both are off until you separately arm them
and name the repositories they may act in: the [Inspector](#inspector-automated-pr-review),
which comments on pull requests under your GitHub account, and
[YOLO mode](#shipping-yolo-mode), which merges them. Their allowlists are deliberately
separate - trusting an automated reviewer to comment in a repo is not the same act as
letting it push to that repo's base branch.
