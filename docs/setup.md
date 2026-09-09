# First-run setup

This walkthrough takes a new checkout from clone to a running Mission Control and
its full verification suite. For the contributor expectations and test policy, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

After Mission Control is running, open **Settings → Setup** for the machine-wide view of
agent CLIs, terminal backends, GitHub CLI authentication, Claude Code extensions, and
ai-conductor.

The panel opens with a verdict for the whole machine - whether it can run sessions, how many
checks are ready, and whether any gap is a required one - above a rail of the five families.
One family is read at a time: the rail carries each family's ready count and marks the ones
with gaps, and the pane beside it holds that family's rows. It opens on the family holding a
required gap, then any gap, and stays where you put it - a **Re-check** that repairs the
family you are reading reports into that family rather than moving the rail. A satisfied row
shows its name, the path or evidence Mission Control found, and the source of an executable
path, such as inherited PATH, login shell, operator override, or version-manager location.
Paths are written relative to your home directory, with the absolute path on hover. Missing rows explain what capability is
unavailable and provide a documentation link or copyable command. A runnable package-manager remedy also offers **Run in a terminal**:
choose an available backend and Mission Control opens a visible terminal running the catalog's
fixed command. The daemon owns the argv, working directory, title, and hold-open shell; the
browser sends only the dependency id and terminal backend. The terminal remains open after the
command exits so you can read its exit code, then use **Re-check** to inspect the machine again.

The Herdr row reports two separate facts, because installing the CLI does not make Herdr usable.
With the `herdr` binary present but its default server stopped, the row is **Needs setup** and
offers **Start the Herdr server** instead of the installation guide. That button opens no
terminal: the daemon starts the server the same way a dispatch to Herdr would, waits for it to
answer, and the panel re-reads the machine on its own, so a repaired row reports Ready without a
manual **Re-check**. A Herdr older than the supported release is reported with its compatibility
reason and is not offered a start, because starting it repairs nothing. While the server is down,
discovery simply sees no Herdr workspaces and logs nothing.

The optional iTerm2 row uses the same `/Applications/iTerm.app`, `~/Applications/iTerm.app`, or
configured `ITERM_BIN` filesystem
check as launch targeting. It never starts iTerm2 while reading Setup. The copyable remedy is
`brew install --cask iterm2`; Automation permission is requested only when an already-running
iTerm2 is controlled or when you explicitly launch through it. See
[iTerm2 Automation and permission recovery](sessions.md#iterm2-automation-and-permission-recovery).

Mission Control never runs the installer inside the daemon. Provider installers such as
ai-conductor additionally require the daemon to resolve exactly one checkout from its verified
workspace candidates, then reverify that candidate when the button is pressed. If there is no
verified checkout, or more than one, Setup links to **Settings → Conductor** instead of offering
a button that must fail or guess.

Mission Control also puts a dismissible reminder above the dashboard on first launch, or when
a required Setup row becomes missing or needs setup. **Open Setup** links directly to this panel.
Dismissal is stored on this machine. A repaired row retires its acknowledgement, so the reminder
returns if that required capability later regresses. An inconclusive **Unknown** result does not
raise the reminder. A dismissal is bound to the required rows in the checks result it came from;
if another tab observes repair or regression first, the stale dismissal is refused and asks the
operator to re-check.

The **Set up this machine** guided tour shows you how to reach this panel and what to do with
it, in four stops: the ⚙ gear, **Setup** in the Settings rail, the dependency list where you
install the tools you will use, and **Re-check** to confirm they took. It runs once
automatically on a fresh profile, and can be started again from **Help & tours** at the bottom
of the Settings rail or from **Start Set up this machine tour** in the command palette. It
executes no remedy, and it leaves you here on Setup rather than returning you to the page you
started from.

Install Node.js 24 or newer and verify it:

```sh
node --version
```

Browser tests also need Playwright Chromium once per machine. `npm install` does not
download it, so install it explicitly when you need e2e coverage:

```sh
npx playwright install chromium
```

## Bootstrap the checkout

```sh
git clone https://github.com/teamupstart/mission-control.git
cd mission-control
make init
```

`make init` is safe to repeat. It installs npm dependencies, builds the application,
and merges the Claude status hooks
into `~/.claude/settings.json` without replacing your other hooks. To validate the
browser prerequisite as part of bootstrap, run:

```sh
make init ARGS="--with-e2e"
```

The init command checks the Node version before it changes the checkout, and checks
for Chromium before build and hook setup when `--with-e2e` is requested. Each failed
check prints the command that fixes it. `make setup` runs the same dependency, build, and hook
steps without the prerequisite walkthrough.

## Run Mission Control

```sh
npm run dev
```

This starts the daemon and Vite dashboard. Open `http://127.0.0.1:5173`. To run the
desktop shell too, use `npm run dev:desktop`; `npm run dev:start` also starts Foreman.

The daemon's default state directory is `~/.mission-control`. It contains the SQLite
database, token, logs, native worktree pools, disposable worktrees, and the
[archive library](archives.md). Set
`MISSION_HOME` to use a separate state root; [configuration.md](configuration.md) documents
that and the other runtime settings. `make db` opens the active database in a read-only
shell.

The Claude status hooks installed by `make init` take effect for sessions started
after installation. Re-run `npm run install-hooks` after changing hook configuration.

Install them from a durable clone. The installer writes absolute paths into
`~/.claude/settings.json`, and those paths do not follow a checkout that is later renamed
or removed: every Claude session on the machine then fails every hook event with
`MODULE_NOT_FOUND`. Settings -> Setup carries a **Claude Code hooks** row that names a dead
path when one appears, and
[troubleshooting.md](troubleshooting.md#every-claude-turn-prints-a-hook-error-with-module_not_found)
covers the repair.

## Verify the checkout

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

The e2e suite drives the built dashboard and built daemon, so build first. It uses
fake agents and does not spend model tokens. See [e2e/README.md](../e2e/README.md) for
focused commands, traces, and its isolation rules.

## Explore without real agent sessions

After building, launch the isolated demo:

```sh
npm run demo
```

Demo mode uses `~/.mission-control-demo` rather than your normal state directory and
replaces agent binaries with local scenario players. `npm run demo -- --fresh` rebuilds
and seeds a populated demo fleet; it takes longer because it drives real application
routes. See [demo-mode.md](demo-mode.md) for its flags and boundaries.

To regenerate the committed README imagery after a dashboard change, first run
`npx playwright install chromium` once on a new machine, then build and run
`npm run docs:screenshots`. The capture tool uses its own disposable demo state root, fixed
viewport, and local scenario players, so it does not use agent models or alter your normal demo.
