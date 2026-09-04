# Harnesses and terminal backends

Mission Control supports several coding agents and terminal environments without spreading
vendor-specific conditionals through the application. A harness describes an agent's
capabilities. Terminal backends describe how Mission Control can discover, focus, capture,
or write a concrete pane.

For the machine's current binary presence and terminal composition, open **Settings → Setup**.
It uses the same harness and terminal binary resolvers as launch, so an environment override
cannot make the launcher and setup report disagree. The panel only links to or copies remedies;
it never installs or executes them.

Bare agent commands are first resolved on the daemon's current `PATH`. If that snapshot misses,
Mission Control refreshes `PATH` asynchronously from the user's login shell and retries. Concurrent
misses share one read, and repeated misses use a short negative-cache window instead of repeatedly
sourcing shell startup files. Each explicit Setup inspection forces one fresh shared snapshot, so a
CLI installed or moved by a version manager becomes available to both Setup and dispatch without a
daemon restart. Mise, asdf, and Volta shim directories are always included as a backstop when shell
startup is unavailable or times out. Their documented `XDG_DATA_HOME`, `ASDF_DATA_DIR`, and
`VOLTA_HOME` overrides take precedence over the standard per-user locations. Mise's more
specific `MISE_DATA_DIR` and `MISE_SHIMS_DIR` overrides take precedence over its XDG location.

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
does not poll and individual controls do not fetch their own lists. Claude Code and Codex continue
to use their shipped static choices.

Pi's rows come from the configured local Pi installation and account, using the same binary
resolution as a Pi launch, including `MISSION_PI_BIN`. The daemon asks Pi for its available models
with one prompt-free RPC command in offline, no-session mode. It does not submit a prompt or call a
model provider. The browser preserves Pi's order and groups every returned row by its reported
provider. The selected value remains one exact provider-qualified string such as
`anthropic/claude-sonnet-5`; no separate provider field is stored.

The daemon caches a successful discovery for five minutes. A dashboard reload normally consumes
that cache. **Retry Pi models** forces the same aggregate read with `?refresh=1`. If refresh fails,
the daemon serves the last successful list when one exists and otherwise returns the compact
shipped Pi fallback. A transport failure in the browser likewise leaves its current choices in
place. These degraded states show a bounded status message, keep every picker and dispatch action
enabled, and never expose Pi's process output.

A saved model absent from the current response is appended once as **not currently reported**. It
remains selected and submit-safe in Harnesses Settings, ordinary and guided dispatch, recurring
missions, Ensemble member rows and summaries, Personas, Foreman, the GitHub Inspector, and the
per-task-kind rows under [Settings → Models → Task kinds](models.md#task-kinds). Catalog absence is
therefore not revocation and never rewrites an operator's selection.

The per-harness **Default model** and **Default effort** on this page are the bottom of the
dispatch ladder rather than the whole of it: a task kind can name its own harness, model and
effort, and those sit one tier above these. See [Which model
wins](dispatch-and-backlog.md#default-model).
