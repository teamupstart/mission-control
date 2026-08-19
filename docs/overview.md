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
  card's title (or press <kbd>⇧</kbd><kbd>O</kbd>) to rename it. Where that name lands depends
  on the runtime, and both are durable: a **terminal** session's name IS its terminal home, so
  the rename moves the multiplexer session (and retitles the tabs hosting it) and the next
  sweep reads it straight back onto the card; an **Agent SDK** session has no home, so the name
  is written to the row the daemon already keeps for it and comes back under that name after a
  restart. Any live session can be renamed except a terminal one found in no backend at all -
  that has nowhere to put a name, so its title isn't clickable - and one that has exited or is
  stopping. A Ghostty tab is named and still cannot be renamed, for a different reason: its
  titles are read-only, so that backend declares no retitle at all. See
  [Which terminal you use is declared](sessions.md#which-terminal-you-use-is-declared-not-assumed).
  - A renamed Agent SDK session **stays** renamed. Left alone, its card follows the title of
    the task it is running, which a dispatch refines with a headless model call moments after
    launching; typing a name overrides that for good. When a generated name is shortened on
    the card, its rename tooltip and accessible description retain up to the accepted
    200-character title limit.
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
  [clickable options on the card](sessions.md#answer-a-sessions-menu-from-the-dashboard).
  Terminal sessions are read straight off their pane, so that path works with or without
  hooks; Agent SDK sessions deliver the same asks as structured data.
- **Dispatches** new agents: pick a repo, describe a task, and it launches an
  agent in its own isolated worktree, using that harness's configured
  [session runtime](sessions.md#session-runtimes-terminal-or-the-agent-sdk), or shelves it in a
  backlog for later, where clicking it [reopens the form](dispatch-and-backlog.md#edit-a-shelved-task) to
  edit or send, and a switch on the row [holds it back](dispatch-and-backlog.md#hold-a-backlog-item-back)
  from the autopilot without taking it off the list).
- **Pulls work in** from systems that already hold it: a [task source](dispatch-and-backlog.md#task-sources-pulling-work-into-the-backlog)
  sweeps GitHub issues or a Jira JQL filter on a schedule and files them into the backlog, so the work you
  already wrote down somewhere doesn't have to be re-typed. It files backlog rows and
  nothing else - it never dispatches an agent and never types into a session. Ships with
  no sources configured.
- **Rounds up** every session: who needs you, who's working, what's idle,
  the backlog, and recent outcomes - as a panel, JSON, or markdown digest.
- **Alerts** you when a session needs you: a desktop notification + sound the
  moment a session needs input, a review lands, a session **gets stuck**, or a
  dispatched task fails - with an **Away mode** that buffers the
  rest and hands you one digest when you come back.
- **Keeps the Mac awake**, if you ask it to: the live indicator opens a **Keep awake**
  dropdown whose switch prevents idle system sleep while the display still dims and locks,
  so agents keep working with the screen dark. Deliberately transient - on until Mission
  Control quits or restarts, never persisted or reacquired - and lid close, manual Sleep,
  and the battery safeguards all still win. macOS only; elsewhere it says so instead of
  pretending. See [Keep awake](sessions.md#keep-awake-prevent-idle-system-sleep).
- **Tracks fleet economics**: a badge on every priced card and a topbar cost chip whose
  popover carries the sessions' Claude + Codex API-equivalent estimate, tokens, estimated
  cost per pull request, and rate-limit runway. A separate automation figure attributes the
  Foreman's and GitHub Inspector's own model spend by role. See [Cost telemetry](sessions.md#cost-telemetry).
- **Says what each prompt-reporting session is for**: its card carries a one-sentence
  **Goal** - what that session is currently trying to solve - derived from your own
  prompts and refreshed as you steer it. No API key: it runs the configured local
  model provider.
- **Triages** the needs-you queue for you: **Foreman** is an optional auto-responder
  that reads each blocked session's transcript, auto-answers the routine calls, and
  escalates the genuine forks as a decision brief - shipping OFF and drafting its
  answers before it ever sends.
- **Builds reusable review workflows**: open **Workflows** in the top bar to author exact
  Markdown Personas and [session actions](workflows.md#session-actions), then arrange Session, Persona,
  all-pass Join, Check, Session action, and End nodes on a validated canvas. Drafts autosave
  with conflict protection and Publish captures immutable Persona and action snapshots. Bind a
  published version to a session and start a manual **Preview** to run concurrent, read-only
  Persona reviews against one immutable evidence snapshot. A session action stage instead
  *sends* one authored instruction to the bound session, waits for that turn, and captures
  fresh evidence for everything below it. A published GitHub Inspector final gate can then require
  the exact clean PR head to pass before the workflow completes.
- **Equips** every session with [skills](skills-and-settings.md#skills-every-session-mixed-reload-behavior): switch
  a skill on in Settings and it is linked into each harness's own skills directory, including
  sessions this app never launched. Claude reloads when idle, Codex watches automatically,
  dispatched identity-bound Pi sessions reload when idle, and operator-started Pi sessions
  pick changes up on their next launch or restart.
- **Lands the clean ones**, if you let it: [YOLO mode](inspector-and-shipping.md#shipping-yolo-mode) merges a pull
  request Mission Control opened once the GitHub Inspector has reviewed and **published** on the
  current push with nothing outstanding, CI is green, no thread is unresolved, and it has
  been open for a soak window you set. Needs the GitHub Inspector on **and** live; dry run merges
  nothing. Ships off, trusting no repositories.

## Quick start

```sh
make init          # one-time bootstrap (deps, build, hooks)
make dev           # daemon + Vite, open http://127.0.0.1:5173
make db            # inspect the live SQLite database in a read-only shell
```

`make db` resolves the same state directory as the daemon and opens its `harness.db`
with both SQLite read-only mode and `PRAGMA query_only` enabled. See the
[SQLite database field guide](sqlite-database.html) for the table catalog, storage
conventions, query examples, and offline backup guidance.

`make init` is idempotent: it installs dependencies, builds, and wires the Claude hooks. Native
worktree pooling is built into the daemon and needs no external allocator. If you'd rather
do the minimum by hand:

```sh
npm install
npm run dev        # daemon + Vite, open http://127.0.0.1:5173
```

Vite serves within a moment; the daemon takes a few seconds longer, and requests the
dashboard makes in that window have nowhere to go. That is expected, and it prints one
line rather than a stack per request:

```
8:15:10 AM [vite] daemon at http://127.0.0.1:7317 is not answering - proxied requests fail until it is up (further failures are summarized)
8:15:14 AM [vite] daemon at http://127.0.0.1:7317 is answering again - 17 requests failed while it was down
```

The same pair appears whenever a server edit restarts the daemon under `tsx watch`. Any
proxy failure other than a refused connection while the daemon is not listening still prints
in full.

Discovery works immediately - your live sessions show up with coarse grey
"running" status. To light up precise **working / idle / needs-input** states
(blue / green / amber) and the review channel, add the two optional integrations
below. Note the hooks only take effect in sessions started *after* you install
them (see [Precise status](sessions.md#precise-status-claude-hooks)).

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

The LaunchAgent builds the native Keep Awake addon with its configured Node before it
exec-replaces itself with the source daemon. Build failure is visible in `daemon.log`, and the
daemon never starts with a missing or stale native artifact.

## Desktop app (macOS)

Prefer a real menu-bar app over a browser tab? Mission Control packages into a native
macOS app (Apple Silicon) that supervises the daemon, shows the dashboard in a window,
and - crucially - **delivers alerts even with the window closed** (a browser tab can't).

```sh
make install        # install the app from a clean, updater-owned clone
```

That is the whole install. It needs `git`, an authenticated `gh` (`gh auth login`), and an
Apple Silicon Mac - it refuses an Intel host rather than building an app that cannot run
there. From a fresh clone it:

- establishes a **separate clone of this repository at `~/.mission-control/app-src` that only
  the updater ever touches**. Your own worktree is never built, fetched, or checked out by it;
- checks out the newest stable release - drafts and prereleases are excluded by the query
  that selects it - or the default branch tip while no release exists yet.
  `make install ARGS="--ref v1.2.3"` installs a specific ref instead;
- builds and packages there, then verifies the packaged app's version equals the source tree's
  before it touches `/Applications`;
- replaces `/Applications/Mission Control.app`;
- writes an install **receipt** at `~/.mission-control/install-receipt.json` recording the
  repository, release tag, version, source clone, and app path. See
  [Desktop shell and packaging](desktop-and-packaging.md#managed-install-and-the-receipt).

Re-running it is safe - every step detects its own completion - and
`make install ARGS="--dry-run"` prints what it would do without changing anything.

The developer path is unchanged, and deliberately separate:

```sh
make app            # build + package → release/Mission Control-<version>-arm64.dmg
make install-app    # …and copy THIS worktree's build into /Applications
```

`make install-app` writes no receipt, so a work-in-progress build is never mistaken for a
managed install.

The app is self-contained: the daemon runs on Electron's bundled Node (with `node:sqlite`),
so no system `node` is required to run it. On launch it **adopts** an already-running daemon
(a LaunchAgent or `make up`) instead of starting a second one. Closing the window hides it
(the app stays in the menu bar so alerts keep firing); quit from the tray menu. Enable
**Start at login** and **Install Claude integrations…** (wires the status hooks + MCP review
server at the app's bundled paths) from the tray menu.

Both paths build on your own Mac and copy the result into place, so nothing crosses a
download boundary and Gatekeeper never quarantines the bundle: the app opens normally, with no
right-click → **Open** and no `xattr` workaround. It is ad-hoc signed rather than notarized -
Developer ID signing is out of scope while the app is built locally.

For desktop development with the same hot-reload loop as the browser:

```sh
make desktop        # daemon (tsx watch) + Vite (HMR) + Electron shell, all auto-reload
make start          # same, plus the Foreman auto-responder worker
make restart        # stop any running stack and start it fresh
```

The window loads the Vite dev server, so React Fast Refresh works inside it exactly as in
the browser; the Electron shell restarts on main-process edits. In this mode `dev:server`
alone owns the daemon and its restart loop; Electron only supervises the daemon in the
packaged app. `make start` adds the [Foreman](foreman.md#foreman-auto-responder) worker to the group
so it comes up with the app (it otherwise only runs via `npm run foreman`); `make restart`
tears the whole stack down and brings it back up. The plain `make dev` browser workflow is
unchanged. See [docs/plans/migrate-electron.md](plans/migrate-electron.md) for the full
design.
