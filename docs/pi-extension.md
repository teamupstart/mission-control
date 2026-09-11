# Pi's Mission Control extension

`npm run build` produces `dist/pi-extension/index.js`. The daemon installs it as a single
machine-wide symlink, `~/.pi/agent/extensions/mission-control.js`, when explicitly enabled.
Fresh hand-run Pi sessions discover it without `-e` and report their Pi session ID and transcript
path through authenticated hook ingest. Building alone installs nothing.

Installation commands, API usage, disabling, and custom Pi homes are documented in the
[README's Pi session integration section](../README.md#pi-session-integration).

The resolver is the skills resolver: `PI_EXTENSIONS_DIR` first, then `pi-extensions` under an
explicit `MISSION_HOME` (including supported legacy aliases), then the real home above. An
isolated daemon therefore never reconciles the machine-wide install against its empty config.

`getPiExtensionConfig()` is the single persisted-intent reader for Phase 6. Intent lives in the
`pi-extension.json` file under the resolved Mission Control state home, defaults off when absent,
and is independent of skills. Writes publish atomically; malformed intent is refused. The writer
shares `src/server/state/isolation.ts` with the database, without importing the database module. This
machine-local installation state is excluded from portable settings backups:
restoring another installation must not opt this machine into loading executable code. A blocked
write returns HTTP 409 with the persisted intent and reconciliation problems; off remains durable
even if a foreign file prevents removal. Startup reconciles that same intent and logs problems.

Real files and directories are never replaced or removed. A symlink is recognized only if its
target is the configured artifact or contains the extension's `missionControlBuild` marker.
This permits repointing a previous checkout's built extension while preserving unrelated links.
Repointing stages a replacement symlink on the same filesystem and publishes it by atomic rename;
a creation or publication failure preserves the prior working link.
An unknown dangling link is refused because its ownership cannot be established. Uninstall of
this checkout's own dangling link still works. No extension or Pi settings file is rewritten.

Hook teardown also calls the extension reconciler, even if no Claude hooks remain. Like skill
teardown, it does not change persisted intent. Plain hook installation never opts Pi in.

Implementation choices for Phase 5: a separate machine-local intent file replaces the proposed
reuse of the skills blob, because skills and executable integration are independently enabled.
The file also permits a standalone install while an older daemon owns SQLite, without replacing
the running app or bypassing database ownership. The CLI and backend configuration API supply
the actionable switch before Phase 6 adds Setup. Ownership
recognition is stricter than the skill name-prefix rule, so an arbitrary symlink at the reserved
name is preserved. Unknown dangling links are reported rather than guessed to be ours. Phase 6
must use `capabilitiesFor("pi").extensions`, `extensionsDirFor`, `linkName`, and the exported intent
reader; it must report staleness without repairing the link.

The extension starts one Node MCP child per active Pi session. It discovers every published tool
from `dist/mcp/server.mjs`, passes its JSON Schema directly to Pi, and forwards execution over
stdio. A tool error throws so Pi sees a failed tool call. Blocking questions wait for the operator;
Pi's abort signal cancels the MCP request. Shutdown and session switches close the old child.
Tool adapters belong to the extension and resolve the current session's child when called.
Unchanged tool definitions register once; changed descriptions or schemas refresh through Pi's
replacement-by-name registration API, and newly discovered names register on demand.
The factory itself starts no processes or timers.

Lifecycle events feed the existing hook registry. Only `agent_settled` maps to `Stop`; `agent_end`
does not complete a work cycle. Human and RPC input start work, while extension-injected input
does not impersonate a human prompt. Pi's UI prompt events report waiting for input. Bash PR
results report URLs and creation provenance without transmitting the command. Live statusline
readings report model, context percentage, and effort, including display-only native levels such
as `off` and `minimal`. Those native readings do not expand the shared effort picker vocabulary.
Both status classification and ingest validation derive shared effort from `THINKING_LEVELS`.

The existing Pi usage reader prices the exact transcript once the extension supplies identity.
An explicit transcript path is accepted only when its bounded first-line header agrees with the
session ID and canonical cwd. Default-home discovery remains the fallback when there is no
reported path. This also permits isolated Pi homes without searching for the newest file.

Hand-run sessions fetch the repository's standing instructions before a turn. If Pi's assembled
prompt options already contain appended system instructions, the extension leaves that delivery
alone. Hook and statusline failures are silent and bounded to 800 ms per request. Tool discovery
has a 15-second handshake budget, a 1 MiB frame bound, a 20-page list bound, and a two-second
child termination grace. Tools have no human-answer timeout.

## Build and downstream contracts

The artifact is self-contained and must retain its `.js` suffix: Pi does not discover `.mjs`
extensions. The builder stages privately on the target filesystem and atomically renames the
complete file. A failed build leaves the prior artifact intact; concurrent builders never expose
an incomplete file.

`piExtensionPath()` owns the output path and honors `MISSION_PI_EXTENSION`. Configured and
explicit build targets must end in `.js`; other suffixes are rejected before any filesystem writes.
The artifact exports
`missionControlBuild`, containing a deterministic SHA-256 `version` and the absolute
`mcpServerPath` resolved at build time. `MISSION_MCP_SERVER` overrides the baked path at runtime.
No token is baked; clients read credentials when sending requests. The future staleness check
must inspect both paths and the marker, without repairing either. The installer must link to the
artifact without relocating it.

The Phase 3 availability seam currently requires a regular `.js` artifact (following symlinks).
Invalid paths, directories, and filesystem errors report unavailable; build validation stays strict.
Phase 6 replaces this temporary
probe with the authoritative installed-extension reading; it must remain the single availability
decider. Setup controls and staleness reporting remain in Phase 6.

## Verification

Focused source tests cover MCP errors, cancellation and bounded failure, lifecycle normalization,
PR attribution, native effort, hand-run identity, and concurrent/failed publication. Bundle smoke
loads the actual `.js` and checks its metadata and settlement subscription.

`e2e/specs/pi-extension.spec.ts` drives a test-owned tmux pane through passive discovery and
loads the actual built extension through the Pi fake. The operator answers `request_input` in
the browser, and the spec checks settlement, model, effort, context and cost. The same spec can
exercise the installed Pi with `MC_E2E_LIVE_PI=/absolute/path/to/pi`; only its local deterministic
provider is used. `node scripts/check-pi-extension.mjs /absolute/path/to/pi` separately proves
`.js` symlink auto-discovery and baked-path tool registration without a daemon. Both use isolated
homes and no external model calls.

Implementation differences from the proposed phase route: Pi's tool-end event has no arguments,
so the extension retains active bash commands until their matching end event. The transcript
locator needed to consume and validate reported paths. Native effort needed a separate display
field rather than a picker-union change. Statusline readings accompany lifecycle events as well
as selection/turn events, allowing an initial discovery race to heal on the next activity.
