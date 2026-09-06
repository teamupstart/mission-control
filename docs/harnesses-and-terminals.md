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

A saved model absent from the current response is appended once as **not currently reported**. It
remains selected and submit-safe in Harnesses Settings, ordinary and guided dispatch, recurring
missions, Ensemble member rows and summaries, Personas, Foreman, the GitHub Inspector, and the
per-task-kind rows under [Settings → Models → Task kinds](models.md#task-kinds). Catalog absence is
therefore not revocation and never rewrites an operator's selection.

The per-harness **Default model** and **Default effort** on this page are the bottom of the
dispatch ladder rather than the whole of it: a task kind can name its own harness, model and
effort, and those sit one tier above these. See [Which model
wins](dispatch-and-backlog.md#default-model).
