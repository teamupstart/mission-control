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
6. Any `node_modules/.bin` directory found in step 4, ranked last.

Step 6 is a demotion, not an extra search path. A package manager puts the project's own
`node_modules/.bin` at the front of the PATH it gives a lifecycle script, so a daemon started
with `make start` or `npm run dev` inherits that checkout's bundled agent CLI ahead of the one
you installed. Mission Control moves those entries below every real installation instead, so
the daemon drives the Codex, Claude, or Pi build you actually maintain even when it was
launched from a checkout whose dependencies lag. They stay reachable at the bottom of the
ladder, because a project-only tool has nowhere else to be found.

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

`missionTools` describes how Mission Control's own tools reach a model, independently of
`mcp`, which describes the vendor's MCP client. Claude and Codex use launch-scoped MCP
registrations reported by their launch builders. Pi declares a machine-scoped installed
extension route and keeps `mcp: null`. The [Pi extension](pi-extension.md) bridges the built
MCP server and reports machine-scoped hooks. When the availability probe fails, Pi plan and
scout requests are refused during repository preparation. Existing backlog tasks,
workflow evidence requirements, and caller-required tools are checked again before dispatch
acquires any worktree. The task keeps the integration refusal in its error field.

The installation decision lives in [`mission-tools.ts`](../src/server/mission-tools.ts).
Its `piExtensionInstalled` probe temporarily checks `piExtensionPath()` for the built artifact.
The installer remains a separate phase, and the later Setup phase replaces this probe with
the authoritative environment reading. A launch that carries tools
still passes the separate MCP bundle `initialize` and `tools/list` verification.

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

## Multiplexer focus terminal

A session hosted in a multiplexer is detached. It has no window until someone asks for one,
and **Focus** is the ask. Each multiplexer whose sessions need a window carries its own
**Opens in** chooser on its row under **Settings > Setup > Terminals**, and Focus opens the
terminal app chosen there.

This is a different setting from the dispatch preference above, and the two coexist. That one
answers which backend *hosts* a dispatched session, is keyed per harness, and admits
multiplexers. This one answers which terminal app *shows* a session already living in a
multiplexer, is keyed per multiplexer, and offers terminal apps only - attaching tmux inside
cmux inside tmux is not a preference.

The shipped value is **Automatic** for every multiplexer, which preserves the previous
behavior exactly: the first terminal app that can open a window, in registry order. An explicit
choice is tried first and the registry order still follows it, so a chosen terminal that is
uninstalled or fails to open still ends with a window rather than an error. Focus now also
checks that a terminal app is installed before spawning it, so a machine with no terminal app
attempts nothing and reports the existing refusal.

The preference is read at focus time, so a change reaches the next Focus without a daemon
restart, and it is recorded in settings backups under the `terminals` domain.

Which rows carry a chooser is the adapter's answer, not the panel's: a multiplexer that draws
its own window declares no attach argv, and its row reads **Needs no terminal** instead. cmux is
the shipped example. A multiplexer that is not installed keeps the control, disabled, since
there is nothing to set a preference for yet.

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

Creation verifies the returned workspace, tab and root-pane identities, the requested label,
and the root pane's cwd. Exact cwd spellings are accepted as before. Different absolute local
paths are equivalent only when both resolve to the same physical path, including macOS
`/var` and `/private/var` aliases. Relative paths and remote URI spellings are not resolved
against the daemon's cwd or filesystem. Differing paths that cannot be proved equivalent, or
an incomplete response, leave the creation outcome unknown. Mission Control does not retry the
creation or close a workspace on that uncertain result.

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

For tty-less multiplexer panes, discovery matches the reported root PID to the representative
agent itself or its observed parent chain in the same process snapshot. This includes a shell
replaced with `exec`: the agent then is the pane root, at distance zero. A direct tty match still
takes precedence; otherwise only the unique closest PID match is accepted. Equal-distance
matches are ambiguous, missing process metadata stays unpaired, and parent cycles terminate
without revisiting the root. Matching a directory or display name cannot authorize this join.
The shared correlator supplies this contract to every multiplexer, independently of its host.

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

### Inventory availability and emulator launch identity

Every terminal adapter's `list` returns `TerminalInventory<T>`: an array for a completed
inventory, including `[]` for confirmed emptiness, or `null` when the inventory is unavailable
or malformed. `readInventory` preserves that distinction when an adapter throws and logs
the backend and original exception at most once per backend per minute across its callers. Discovery
passes the inventory snapshot alongside correlated sessions to Registry, including unavailable
and empty results. Registry uses that same snapshot when a task refreshes its session.
Home liveness and cleanup retain uncertainty.
tmux's definitive empty-server or missing-socket diagnostics count as completed empty
inventory even though the CLI exits nonzero. Timeouts, permission errors, partial output
and unrecognized diagnostics remain unavailable. Saved exact tmux sessions also have their
existing socket- and server-identity liveness check.
`homeAlive` returns `null` on unavailable inventory and only a completed inventory can
establish that a recorded resource is absent. Legacy emulator records without an exact
resource cannot establish absence through a mutable title. Unknown observations do not
authorize worktree release.

Emulator spawn results retain their pane address as `emulator:<backend>:<paneId>` in the
existing task `terminalResourceId`. Before dispatch adopts an agent, it requires the exact
observed pane or verifies the agent's process ancestry through the private launch wrapper,
checking the wrapper command and both process start times. If the initial wrapper lookup
is too early, adoption reads the private launch marker after session readiness. A captured
process identity still takes precedence over a later marker; the marker location is ephemeral
and is never persisted on the task. The task's
`terminalLaunch` pairs that resource with the exact process-lifetime session ID. It is stored
in an additive nullable `tasks.terminal_launch` JSON column. Existing tasks migrate with no
proof; an old resource selected by a cwd heuristic is not promoted into a verified binding.
Malformed proof is read as absent, and a new launch clears the previous binding.
`Registry.adoptTerminalLaunch` owns verification, durable proof construction, task/session
refresh and work-episode binding for dispatch, SDK handoff and explicit resume. It rechecks
the task's state, session owner and recorded resource after verification before adopting.
The adopted resource outranks the previously cached inventory until the next completed
discovery sweep. This freshness exception applies only to that exact resource, so adopting
a new pane does not restore a different pane whose absence was already confirmed.

Registry associates an enumerated emulator pane with its bound session by the proven UUID.
Launch projection replaces or removes only that backend's handle, preserving other backends.
A completed inventory that omits that UUID removes its handle. Without another usable handle,
the composer is disabled and writes are refused even while the process survives. Unavailable or unobserved inventory
allows restoration of the saved address, and only when the proof matches the bound session
and recorded resource and the adapter declares `restoreTarget`. Ghostty and iTerm2 use stable
UUID addresses; WezTerm declares this capability absent because its recyclable numeric IDs
need incarnation policy. That policy and later backends' native verification remain in their
own phases. No terminal ID encodings or append-only backend IDs change here.

Ghostty does not report a TTY. An external session therefore remains handleless unless an
independent exact correlation is available. Shell cwd, agent cwd, GUI ancestry, mutable
titles and a single unmatched pane do not prove a recipient. Exact TTY correlation and
multiplexer root-process ancestry continue to work unchanged. A verified dispatched Ghostty
session keeps its UUID during an inventory failure and after daemon restart, without a
global timeout increase or a second session-removal path.

### WezTerm mux lifetime and input safety

WezTerm reuses numeric pane IDs after its native mux server restarts. A discovered
`EmulatorTarget` therefore carries an optional `incarnation` alongside its pane and tab IDs.
WezTerm requires that proof for text, paste, keys, capture, focus and retitle. A stale or
legacy handle is refused until discovery supplies a current handle. Stable UUID backends
need no incarnation field, and their restoration behavior is unchanged.

The adapter first asks WezTerm to select its normal default endpoint with
`--no-auto-start` and the inherited `WEZTERM_UNIX_SOCKET` removed. The CLI's socket trace
locates that endpoint; its preliminary pane list does not establish target identity.
The adapter then hard-links the socket and enumerates through that private alias. Its
incarnation records device, inode and birth time. Every target operation repeats endpoint
selection, pins the socket, compares the incarnation and keeps the link until the command
finishes. A restart between validation and execution cannot redirect the alias to the new
socket. The alias is no longer than the original socket basename, to preserve Unix socket
path limits, and is removed in `finally`. A collision never overwrites another entry.

Only the explicitly pinned alias is supplied to the command's environment through the
fixed OS `env` executable. This does not restore inherited socket routing or permit auto
start. Spawn, retitle and the returned target lookup share one pin, so a restart cannot
turn a spawn result into a handle for a replacement pane. Unknown endpoint diagnostics,
non-socket endpoints, unavailable birth time and failed hard links are unavailable
inventory or refused operations, never confirmed emptiness or guessed identities.
The diagnostic format is an upstream compatibility dependency; an incompatible version
fails conservatively. Native verification used WezTerm 20240203-110809-5046fc22 on macOS.

The incarnation is an observation on a live handle, not a new task storage format.
Existing `terminalResourceId` values and Phase 5 launch-process proof remain compatible.
WezTerm still declares `restoreTarget: null`: a saved numeric resource is not sufficient
to recreate write authority after a daemon restart. Fresh discovery supplies that authority.
Neither an unavailable observation nor a refused operation creates an eviction or cleanup
path. Actions continue to own delivery policy; the adapter owns socket addressing.


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

**Amazon Bedrock is one of those providers, not a Mission Control feature.** Sign in to it from a
Pi session with `/login amazon-bedrock`, and Pi's next catalog answer lists whatever models that
account offers - `amazon-bedrock/deepseek.v3.2`, `amazon-bedrock/anthropic.claude-sonnet-4-5`, and
so on - grouped under `amazon-bedrock` like any other provider. Mission Control keeps no allowlist
of Bedrock models, no region, no profile name, and no AWS credential of any kind: the id is passed
through to Pi unchanged on both runtimes, and Pi makes the call. Refreshing an expired AWS session
is a Pi login, not a Mission Control setting.

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
it is probably not signed in, and then names the step - open a Pi session and run
`/login <provider>` (`/login amazon-bedrock` for Amazon Bedrock), or set that provider's API key,
or run `codex login` in a terminal. Pi's sentence names the command rather than one vendor's
account, because Pi's catalog is whatever provider the operator configured. Retry alone cannot
resolve it, which is why the notice no longer offers only that.

A saved model absent from the current response is appended once as **not currently reported**. It
remains selected and submit-safe in Harnesses Settings, ordinary and guided dispatch, recurring
missions, Ensemble member rows and summaries, Personas, Foreman, the GitHub Inspector, and the
per-task-kind rows under [Settings → Models → Task kinds](models.md#task-kinds). Catalog absence is
therefore not revocation and never rewrites an operator's selection.

The per-harness **Default model** and **Default effort** on this page are the bottom of the
dispatch ladder rather than the whole of it: a task kind can name its own harness, model and
effort, and those sit one tier above these. See [Which model
wins](dispatch-and-backlog.md#default-model).
