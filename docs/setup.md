# First-run setup

This walkthrough takes a new checkout from clone to a running Mission Control and
its full verification suite. For the contributor expectations and test policy, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

After Mission Control is running, open **Settings → Setup** for the machine-wide view of
agent CLIs, terminal backends, GitHub CLI authentication, Claude Code extensions, and
ai-conductor. Missing rows explain what capability is unavailable and provide a documentation
link or copyable command. The page never runs an installer or setup command.

Mission Control also puts a dismissible reminder above the dashboard on first launch, or when
a required Setup row becomes missing or needs setup. **Open Setup** links directly to this panel.
Dismissal is stored on this machine. A repaired row retires its acknowledgement, so the reminder
returns if that required capability later regresses. An inconclusive **Unknown** result does not
raise the reminder. A dismissal is bound to the required rows in the checks result it came from;
if another tab observes repair or regression first, the stale dismissal is refused and asks the
operator to re-check.

The **Set up this machine** guided tour explains families, statuses, remedies, and **Re-check**
without executing a remedy. Start it from **Help & tours** at the bottom of the Settings rail or
from **Start Set up this machine tour** in the command palette.

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
git clone <repository-url>
cd ai-harness
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
