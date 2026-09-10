# Harnesses and terminal backends

Mission Control supports several coding agents and terminal environments without spreading
vendor-specific conditionals through the application. A harness describes an agent's
capabilities. Terminal backends describe how Mission Control can discover, focus, capture,
or write a concrete pane.

For the machine's current binary presence and terminal composition, open **Settings > Setup**.
Each ready executable row shows the absolute path and where Mission Control found it. The same
resolved path and child environment are then used for detection, model discovery, installation
probes, and launch. The panel only links to or copies remedies; it never installs them itself.

The daemon initializes one executable environment before it opens state or starts discovery. This
happens for direct CLI and LaunchAgent starts, Electron-spawned daemons, Electron-adopted compatible
daemons, and the separate Foreman worker. Resolution has a fixed order:

1. A per-tool `MISSION_`, `FLEET_`, or `HARNESS_` override, followed by retained legacy names.
2. Supported absolute application locations, including `/Applications` and `~/Applications`.
3. Absolute directories from `MISSION_EXECUTABLE_PATHS` and its legacy prefix forms.
4. The PATH inherited by the process, then one bounded login-shell PATH reading.
5. Supported version-manager and OS locations.

No step scans the filesystem. Login-shell reads time out after five seconds, concurrent reads
coalesce, and misses share a 30-second negative cache. An explicit Setup re-check forces a new
snapshot, so an install or shell PATH change becomes visible without restarting the daemon. Mise,
asdf, and Volta locations are compatibility backstops rather than the primary answer. The resolver
honors `XDG_DATA_HOME`, `MISE_DATA_DIR`, `MISE_SHIMS_DIR`, `ASDF_DATA_DIR`, and `VOLTA_HOME` before
their standard per-user locations.

The browser-safe capability registry lives in
[`src/shared/harness-capabilities.ts`](../src/shared/harness-capabilities.ts). The daemon's
[harness registry](../src/server/harness/index.ts) adds process, filesystem, transcript,
hook, and SDK adapters. Callers ask for a capability instead of branching on an agent name.

Terminal mechanics are similarly collected in the [terminal registry](../src/server/terminal/registry.ts).
Multiplexer and emulator adapters can compose for one visible session. The binding layer
chooses the innermost pane for writing and capture, while focus walks outward to the
application that can show it to the operator.

The multiplexer registry contains tmux, Herdr, and cmux in that order. The order preserves an
inner tmux pane as the most specific identity, then prefers a persistent Herdr workspace over the
outer self-hosting cmux surface when more than one backend can describe a process.

cmux needs two things from the machine beyond its CLI, both checked and repairable in
**Settings > Setup**: its app has to be running, since the control socket exists only while it
is, and `automation.socketControlMode` has to be `allowAll` rather than the shipped `cmuxOnly`,
which admits only processes cmux started itself. It is also the one backend whose paste submits.
cmux's typing method writes a leading ESC in a terminal write of its own, so bracketed-paste
markers written by hand reach the agent as an Escape keypress and the literal text `[200~`; its
real paste verb delivers them correctly and appends a carriage return that no parameter
suppresses. The adapter reports that the paste submitted and prompt delivery skips its own
Enter, which is why the paste result carries the fact rather than the caller assuming it.

## Dispatch terminal preference

Each terminal-backed harness has a **Terminal** chooser under **Settings > Harnesses**. The
shipped value is **Automatic**, which preserves the existing launch policy: use installed
multiplexers in registry order when any are available, otherwise use installed terminal apps in
registry order. The detailed chooser groups those two axes, explains what each launch creates,
and leaves unavailable integrations visible with the reason they cannot be selected.

An explicit tmux, Herdr, cmux, WezTerm, Ghostty, or iTerm2 choice is exact. The next dispatch for
that harness uses only the selected backend and reports a launch error if it is no longer
available rather than silently opening somewhere else. The setting is read at dispatch time, so
a change reaches the next launch without a daemon restart. It is retained while the harness uses
the Agent SDK runtime and becomes visible again if the runtime returns to Terminal.

The backend that created an explicitly selected terminal home is stored on the task beside its
home name. Liveness checks and cleanup use that durable backend identity, so changing the setting
later cannot re-aim an already-running task at another terminal. Historical and Automatic tasks
keep their existing registry-based lookup behavior.

## Herdr

Mission Control supports stable Herdr 0.8.2 or newer on protocol 20 or newer. A newer protocol
generation is accepted: the response schemas, not the generation number, are what refuse a Herdr
that has actually changed. Set `HERDR_BIN` to an executable path to override the normal `herdr`
lookup on `PATH`. Setup, passive discovery, launch, and pane actions all use the same binary
contract.

The initial adapter is allowlisted to macOS and Linux. It uses a Unix socket and POSIX `env -u`
namespace scrubbing. Windows named-pipe transport and Windows-compatible environment scrubbing are
not yet supported, and other platforms have not been validated. Herdr stays visible but disabled
on those hosts with the reason **Herdr integration is supported on macOS and Linux only**.

This version controls only Herdr's default local server session. It deliberately clears inherited
Herdr session, socket, workspace, tab, and pane selectors for status, startup, and full-client
launches. Named Herdr servers are outside this compatibility boundary.

Through the common multiplexer controls, Mission Control can create and discover workspaces, write
text and keys, apply multiline bracket-aware paste without submitting it, capture visible pane
text, focus an agent inside Herdr, rename a workspace, close it, detach a client, and reattach a
normal full client. Passive discovery and actions on an existing pane never start a stopped
server. Workspace creation is the only path that may start the default server.

Herdr's socket API has no command parameter, so a dispatch is delivered by typing it into the new
workspace's login shell. Mission Control sends the command and its Enter as separate writes, and
then confirms the pane is running something other than that shell before it reports the launch as
successful. A launch that is delivered but never executed closes its workspace and reports
**Herdr accepted the launch command but the shell never ran it**, rather than succeeding and
surfacing thirty seconds later as a dispatch timeout. When Herdr cannot say what the pane is
running, the launch fails as uncertain and the workspace is left alone, because closing it could
close a live agent.

A pane whose process details cannot be read is listed with an unknown process id rather than
removing every other Herdr pane from the dashboard for that refresh.

Stable Herdr does not expose attached-client tty identities. Mission Control can still select the
correct agent inside Herdr, but if no already-correlated terminal host can be raised, Focus opens a
normal full Herdr client through the existing terminal fallback. Repeated Focus may therefore open
another client. Mission Control never uses direct-attach takeover.

Detaching a normal Herdr client leaves the server-owned panes and their processes running, so a
later full client can reattach. Stopping the Herdr server is different: Mission Control does not
claim arbitrary pane processes survive a full server stop.

With the Herdr CLI installed and its default server stopped, passive discovery reports no Herdr
panes and logs nothing, exactly as tmux and cmux do when they are installed and idle. The state is
reported once, where it can be acted on: the Herdr row in **Settings > Setup** probes the server
and offers **Start the Herdr server**, which runs the daemon's own startup rather than opening a
terminal. See [First-run setup](setup.md).

The emulator registry currently contains WezTerm, Ghostty, and iTerm2 in that order. iTerm2
uses its built-in AppleScript dictionary behind the same capability contract. It enumerates
windows, tabs, and split sessions, addresses every action by the session's stable unique ID,
correlates by normalized TTY, writes text and keys, bracket-pastes prompts, captures visible
contents, focuses an exact split, opens a titled window in a requested worktree, and retitles
the containing tab. Working directory is best effort because iTerm2 reports it through the
shell-integration `path` variable. A missing value leaves `cwd` unknown and does not disable
the session.

An iTerm2 session running tmux composes without a special route. Writes and captures go to
the inner tmux pane. Focus selects that pane, joins the tmux client TTY to its outer iTerm2
session, and raises the exact iTerm2 split. If no client is attached, the existing focus
fallback opens a new iTerm2 window running tmux's attach argv.

iTerm2's app-bundle path proves installation, while the shared host-process gate proves the
GUI is already running before enumeration may use Apple Events. This separation is the
no-auto-launch contract: Setup and passive discovery can report a closed installation but
cannot open it. An explicit terminal launch is allowed to start iTerm2. See
[iTerm2 Automation and permission recovery](sessions.md#iterm2-automation-and-permission-recovery)
for the macOS permission lifecycle.

This is the technical counterpart to [Sessions and conversations](sessions.md). The rules
for adding a harness, preserving browser-safe shared code, and using capability predicates
are in the authoritative [harnesses and terminals contract](agent-guides/architecture.md#harnesses-and-terminals)
and [harness-change contract](agent-guides/change-contracts.md#harness-changes).

## Dispatch-time model catalogs

Every model picker that can affect a dispatch reads one browser catalog. The browser starts with
the shipped choices, then reads the daemon's aggregate catalog once when the dashboard loads. It
does not poll and individual controls do not fetch their own lists. Claude Code continues to use
its shipped static choices; Codex and Pi discover theirs.

Pi's rows come from the configured local Pi installation and account, using the same binary
resolution as a Pi launch, including `MISSION_PI_BIN`. The daemon asks Pi for its available models
with one prompt-free RPC command in offline, no-session mode. It does not submit a prompt or call a
model provider. The browser preserves Pi's order and groups every returned row by its reported
provider. The selected value remains one exact provider-qualified string such as
`anthropic/claude-sonnet-5`; no separate provider field is stored.

Codex's rows come from the configured local Codex installation and account, resolved the same way
a Codex launch resolves it, including `MISSION_CODEX_BIN`. The daemon runs `codex app-server`,
completes the handshake, asks `model/list`, and exits. **It starts no thread and no turn**, so the
probe cannot spend anything, and it runs from a temporary directory so the answer describes the
installation rather than whichever repository triggered it. Codex reports no per-row provider or
context window, so its rows stay ungrouped and carry neither; rows Codex hides from its own picker
are excluded here too, and the selected value remains the exact model id such as `gpt-5.4`.

Discovering Codex's list means the picker can now offer a model Mission Control has no price for.
The [standard-price snapshot](sessions.md#cost-telemetry) recognizes a fixed set of ids and
intentionally leaves a new model unpriced rather than guessing its rate, so such a session runs
normally and simply reports no estimated cost.

The daemon caches a successful discovery for five minutes, per harness. A dashboard reload normally
consumes that cache. **Retry Pi models** and **Retry Codex models** force the same aggregate read
with `?refresh=1`. If refresh fails, the daemon serves that harness's last successful list when one
exists and otherwise returns its compact shipped fallback. A transport failure in the browser
likewise leaves its current choices in place. These degraded states show a bounded status message,
keep every picker and dispatch action enabled, and never expose the probe's process output. A Codex
too old to know `model/list` reports the same fallback as any other failure rather than an error.

One degraded state is not a failure at all and is named separately: both harnesses answer with the
models the account they are **signed in to** offers, so a signed-out installation replies
successfully with an empty list. The notice says the harness reported no available models and that
it is probably not signed in, and then names the step - open a Pi session and run `/login` to
connect an Anthropic or Claude account (or set that provider's API key), or run `codex login` in a
terminal. Retry alone cannot resolve it, which is why the notice no longer offers only that.

A saved model absent from the current response is appended once as **not currently reported**. It
remains selected and submit-safe in Harnesses Settings, ordinary and guided dispatch, recurring
missions, Ensemble member rows and summaries, Personas, Foreman, the GitHub Inspector, and the
per-task-kind rows under [Settings → Models → Task kinds](models.md#task-kinds). Catalog absence is
therefore not revocation and never rewrites an operator's selection.

The per-harness **Default model** and **Default effort** on this page are the bottom of the
dispatch ladder rather than the whole of it: a task kind can name its own harness, model and
effort, and those sit one tier above these. See [Which model
wins](dispatch-and-backlog.md#default-model).
