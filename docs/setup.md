# First-run setup

This walkthrough takes a new checkout from clone to a running Mission Control and
its full verification suite. For the contributor expectations and test policy, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

If you are installing Mission Control to use rather than to work on, read the illustrated
[setup guide](setup-guide.html) instead. It covers the same Setup panel from the operator's
side, with screenshots, a required-versus-optional breakdown of every row, and how updates
arrive.

## Install the desktop binary

For ordinary desktop use, the [binary installer and manual recovery route](desktop-and-packaging.md#binary-installation-and-manual-recovery)
requires macOS 12+ on Apple Silicon and native GitHub CLI authentication, without host Node,
npm, npx, Git or local compilation. Signed release qualification is still pending; unavailable
assets refuse installation. Existing source installs can be replaced in place by this command
once assets are published, preserving their state and destination. Copied signed DMGs can enroll
through **Settings > Setup > Application updates**. Reopen an enrolled app to enable automatic stable and exact-SHA alpha binary updates.

The commands below concern source development. Electron includes Node for the desktop app,
updates and Mission-owned helpers. Independent agent CLIs, user projects and optional Conductor
keep their own prerequisites.

## Prerequisites

After Mission Control is running, open **Settings → Setup** for the machine-wide view of
agent CLIs, terminal backends, GitHub CLI authentication, agent extensions,
ai-conductor, and the system Node.js runtime.

The panel opens with a verdict for the whole machine - whether it can run sessions, how many
checks are ready, and whether any gap is a required one - above a rail of dependency families.
One family is read at a time: the rail carries each family's ready count and marks the ones
with gaps, and the pane beside it holds that family's rows. It opens on the family holding a
required gap, then any gap, and stays where you put it - a **Re-check** that repairs the
family you are reading reports into that family rather than moving the rail. A satisfied row
shows its name, the path or evidence Mission Control found, and the source of an executable
path, such as inherited PATH, login shell, operator override, version-manager location, or
project-local node_modules.
Paths are written relative to your home directory, with the absolute path on hover. Missing rows explain what capability is
unavailable and provide a documentation link or copyable command. A runnable package-manager remedy also offers **Run in a terminal**:
choose an available backend and Mission Control opens a visible terminal running the catalog's
fixed command. The daemon owns the argv, working directory, title, and hold-open shell; the
browser sends only the dependency id and terminal backend. The terminal remains open after the
command exits so you can read its exit code, then use **Re-check** to inspect the machine again.

Pi's **Agent SDK** runtime is unlocked only when Setup reports two ready rows: the global Pi
CLI in **Agent CLIs** and the Mission Control Pi extension in **Agent extensions**. The Pi CLI
row offers `npm install -g @earendil-works/pi-coding-agent` through **Run in a terminal**; the
extension row offers **Install Pi integration** on a first install. After both complete, use
**Re-check**, then choose Agent SDK under **Settings → Harnesses**. If either prerequisite is
missing or unhealthy, that runtime option remains disabled.

The **Agent extensions** family offers **Install Pi integration** on first use and
**Repair Pi integration** for an owned unhealthy installation. The app copies its bundled
integration into its state home, verifies hashes, loads it in a bounded child, and checks real
MCP tool discovery before publishing Pi's link. No clone, npm command or terminal is required.
Start a fresh Pi session afterward. Enabled integration updates reconcile on daemon startup;
old generations remain available to running sessions. Foreign entries stay untouched and need
their owner to move them. **Re-check** reports current health without changing files. A machine
that never installed Pi integration has no required Pi warning.

When the UpstartClaw core plugin is installed, this family also keeps an **UpstartClaw core
setup** row visible. A completed setup reads **Ready**; missing, unfinished, malformed, or
unreadable setup state reads **Needs setup** and offers the interactive setup skill command.
The row links to [Running Mission Control at Upstart](upstart.md), which includes the marketplace,
plugin installation, sign-in, restart, daemon certificate, and verification steps. Machines
without the plugin remain free of Upstart-specific setup chrome.

The **Runtime** family identifies the process serving this dashboard: the app's bundled
Electron runtime, development Electron, or standalone Node. Connecting an Electron window to
an existing source daemon does not change that daemon's runtime. Older daemons without this
field report **Serving runtime unknown**.

External **Node.js** is optional for desktop use. Its diagnostic uses the source-development
minimum (currently Node.js 24), while third-party tools retain their own version requirements. It reports a missing or older runtime as
**Needs setup**, and failed or unparseable version probes as **Unknown**. **Run in a terminal**
opens `brew install node` in the selected visible terminal to install or update Node.js and npm.
This command requires Homebrew; if you manage Node another way, select a supported version in
that manager instead. Read the command's exit status, then press **Re-check**. Opening the
installer alone never marks Node ready. If `MISSION_NODE_BIN`, a version manager, or inherited
PATH still selects an older runtime, correct that selection and restart Mission Control with
the corrected environment. Desktop binary updates do not use that host runtime, and this row
never creates a universal Setup warning. Other required gaps and first-launch guidance remain.

In the desktop app, **Agent extensions > Install Claude integrations** installs or repairs
owned hooks and MCP registrations using the app runtime, including existing source registrations
with a recognized literal command. Existing owned statusline wrappers move to the bundled wrapper;
their saved inner command stays unchanged, with its independent prerequisites. No statusline or
third-party inner command is installed implicitly. Custom syntax, disabled registrations, comments,
permissions and unrelated settings are preserved. Concurrent edits leave recovery originals and
manual reconciliation guidance. The tray menu offers the same action. See the
[owned-runtime inventory and R2 handoff](owned-runtimes.md).

The Herdr row reports two separate facts, because installing the CLI does not make Herdr usable.
With the `herdr` binary present but its default server stopped, the row is **Needs setup** and
offers **Start the Herdr server** instead of the installation guide. That button opens no
terminal: the daemon starts the server the same way a dispatch to Herdr would, waits for it to
answer, and the panel re-reads the machine on its own, so a repaired row reports Ready without a
manual **Re-check**. A Herdr older than the supported release is reported with its compatibility
reason and is not offered a start, because starting it repairs nothing. While the server is down,
discovery simply sees no Herdr workspaces and logs nothing.

The cmux row reports three facts for the same reason, and two of them are not installation.
cmux's control socket exists only while its **app is running**, and cmux ships
`automation.socketControlMode: "cmuxOnly"`, which admits only processes started inside cmux -
the daemon is not one, so with the default every call it makes is denied. Under either fault the
adapter simply sees no cmux workspaces, which is why the row used to read Ready on the strength
of the binary alone while every dispatch to cmux failed. A closed app is **Needs setup** and
offers **Open cmux**, which opens the app and waits for its socket to answer. A refusing socket
is **Needs setup** and offers **Allow Mission Control to drive cmux**, which sets that one value
to `allowAll`, copying `~/.config/cmux/cmux.json` to a timestamped `.bak` first when there is
already a file to copy - a machine with no cmux config yet gets one written and nothing is backed
up. Your comments and every other setting are left alone, and a file that does not parse is
refused rather than replaced. No reload is needed - cmux watches the file - and no reload would be
possible anyway, since `cmux reload-config` is one of the calls the default refuses. A satisfied
row reports the mode it read, as `(socket control allowAll)`.

The optional iTerm2 row uses the same `/Applications/iTerm.app`, `~/Applications/iTerm.app`, or
configured `ITERM_BIN` filesystem
check as launch targeting. It never starts iTerm2 while reading Setup. The copyable remedy is
`brew install --cask iterm2`; Automation permission is requested only when an already-running
iTerm2 is controlled or when you explicitly launch through it. See
[iTerm2 Automation and permission recovery](sessions.md#iterm2-automation-and-permission-recovery).

Package installers never run inside the daemon. Provider installers such as
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
it, then continues into **Trust**, in seven stops: the ⚙ gear, **Setup** in the Settings rail,
the dependency list where you install the tools you will use, **Re-check** to confirm they
took, then **Trust** in the rail, its repository-by-grant matrix, and the pane that adds
repositories to it. It runs once automatically on a fresh profile, and can be started again from
**Help & tours** at the bottom of the Settings rail or from **Start Set up this machine tour**
in the command palette. It executes no remedy and clicks no grant, and it leaves you on Trust
rather than returning you to the page you started from. See
[Trust](skills-and-settings.md#trust-who-may-act-in-which-repository) for what each column
permits.

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

### Installed macOS name

The current binary is Agent Mission Control.app. Use the current installer for an old-name
installation; it preserves the existing folder, scope and state. Saved old bootstraps refuse
the new layout. See [migration and compatibility](app-name-migration.md).

## Optional CodeRabbit workflow reviews

Settings > Setup reports the optional CodeRabbit CLI path/source, minimum version 0.9.1 and
stored authentication readiness without installing, signing in or reviewing. Follow the
[official installation guide](https://docs.coderabbit.ai/cli), then run `coderabbit auth login`
under the same effective HOME as the daemon and press Re-check. Managed invocations disable
auto-update and never authorize usage credits. YAML must explicitly enable each repository;
installation and login alone do not enable review. YAML-enabled blocks link directly back to
Setup. See [workflow configuration and findings](workflows.md#local-coderabbit-command).
