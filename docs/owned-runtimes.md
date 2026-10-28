# Mission-owned runtimes

The installed desktop app includes Node through Electron. Desktop installation, verified binary
updates and Mission-owned integrations do not require an operator-managed Node, npm or npx.
This is an implementation capability. Actual signed installation, stable/alpha updates and
recovery remain release qualification under [R1/R2](plans/desktop-without-system-node/forward-rollout.md).

Source development requires Node.js 24+, npm and the documented build tools. Independent agent
CLIs, optional Conductor, project/workflow commands and a user's statusline inner command retain
their own prerequisites. The app never changes global PATH, version-manager selections or a
project's Node version to satisfy this promise.

## Consumer inventory

| Consumer | Runtime owner and launch | Boundary |
| --- | --- | --- |
| Desktop daemon and Foreman | `src/main/daemon.ts`, `foreman.ts`, `utility-supervisor.ts`: Electron utility processes | An adopted standalone daemon keeps its original executable. Foreman remains HTTP-only. |
| Binary preparation and detached apply/install | `src/main/update-binary.ts`, `scripts/update-helper-runtime.mjs`, `install-binary.mjs`, `apply-update.mjs`: existing bundled worker and independent complete runtime snapshot | Phases 1-4 own identity, signing, receipt, transaction and recovery. No source fallback. |
| Dispatched MCP and capability probes | `src/server/mission-mcp.ts`: `resolveOwnedRuntime` with the serving process's absolute executable and explicit Electron/Node facts | Task checkout shims cannot select the runtime. Source daemons preserve their executable, even if renamed. |
| Installed Claude hooks and global harness MCP | `src/main/integrations.ts`, `integration-runtime.ts`: current Electron executable in Node mode | External agent CLIs remain independently installed. Existing registrations are repaired surgically. |
| Codex hook and resume/check wrappers | `mission-mcp.ts`, `harness/resume.ts`, `terminal/resume-guard.ts`: same daemon descriptor | Node mode is removed before the guard launches the independent agent. User argv stays unchanged. |
| Workflow Check supervisor shim | `workflows/check-spawn.ts`: pure resolver with the serving daemon's explicit runtime context | Only the owned supervisor uses this runtime. It removes Node mode before executing the unchanged user command and environment. |
| Pi Setup installation and repair | `setup/pi-extension.ts`, `extensions/pi-publisher.ts`: runs inside the serving daemon | No installer subprocess is needed. Existing generation ownership, hashes, leases and publication remain intact. |
| Pi candidate load and bridge check | `extensions/pi-candidate.ts`: daemon-owned descriptor | Candidate code executes in a bounded child, never inside the daemon. |
| Pi terminal extension's MCP child | `src/pi/extension.ts`, `mcp-client.ts`: obtains the serving daemon descriptor from `/api/integrations/runtime`, then uses the pure resolver | Pi CLI itself keeps its interpreter. Explicit `MISSION_MCP_SERVER` overrides keep Pi's current runtime. Missing/old daemon capability does not invent bundled readiness. |
| Pi standalone installer bundle | `dist/pi-installer/index.mjs`, built from `scripts/install-pi-extension.ts` | Runs with the selected owned runtime; source CLI invocation remains an explicit developer command. |
| Existing statusline wrapper | `hooks/harness-statusline.mjs` bundled as `dist/satellites/harness-statusline.mjs` | Only the owned wrapper is retargeted. The saved inner command and its interpreter stay independent; no implicit `npx` default. |
| Source hook/statusline installers | `hooks/install.mjs`, `install-checks.mjs`: supported external Node with durable source paths | Explicit source-only commands; transient-checkout refusal remains. Source uninstall recognizes the bundled wrapper and restores the saved command. |
| Source build, service and maintenance scripts | `scripts/install-source.sh`, `install-app.mjs`, `init.mjs`, `install-service.mjs`, package scripts | Explicit developer/standalone entry points, outside the installed desktop promise. |
| Config relocation and login | `migration-integrations.ts`, `migration-integration-config.ts`, `migration-integration-file.ts`, `migration-integration-ports.ts` | Existing journal and native login owner remain. Node mode never applies to GUI relaunch. |

The statusline build is included by the existing `dist/**/*` package allowlist. No packaging,
release producer, signing credential, protection or publisher policy changes are required.
New owned satellites must use the same pure resolver and receive real execution coverage.

## Existing-registration repair

Use **Settings > Setup > Agent extensions > Install Claude integrations**, or the tray's same
command. Existing literal source and packaged hook commands, the named Mission MCP registrations
and an already installed Mission statusline wrapper are retargeted to the running app. This also
repairs absolute paths after moving the app, without moving the app again. It does not opt an
unwrapped statusline into the feature.

Ownership requires the known script suffix, an absolute recognized Node/Electron executable,
and the installer's literal command shape. Opaque shell programs, custom wrappers, extra MCP
arguments, custom configuration homes and unsupported TOML spellings require manual retargeting.
Historically hand-named MCP aliases must be reconciled manually; the installer only owns the
harness registry's named registration. Disabled registrations and hook flags stay disabled.

JSONC edits target owned command fields, preserving comments, hook matchers/timeouts, permissions,
unrelated hooks and user environment. The normalized MCP adapter preserves supported TOML
comments and custom options. The shared migration publisher retains displaced originals and
uses no-replace publication. A concurrent edit is preserved and reported for reconciliation;
retry checks retained originals, including late writes through an editor's open descriptor.
Repeat repair is byte-stable. Uninstall restores the saved statusline command, and Node mode is
removed before delegating to that command.

Repair collapses duplicate owned hooks per event, retaining the first hook's settings and
preserving unrelated hooks. MCP removal rechecks the configuration identity and registration
immediately before invoking the vendor CLI, and refuses removal if either changed. The vendor
CLI owns the subsequent write and offers no atomic compare-and-remove operation; an edit after
that final check remains outside Mission Control's publication guarantees.

## Setup and compatibility

Setup's optional runtime field describes the process actually serving the request. The desktop
label requires Electron, a utility-process parent port and matching executable/module bundle
paths. Development Electron, standalone Node and an absent older-daemon field have distinct,
honest labels. An Electron window adopting a source daemon cannot turn its label into bundled.

The persisted `node-runtime` identifier remains unchanged. External Node diagnostics keep path,
version, resolution source and source-development remedies, including unknown probe outcomes.
The row is optional for desktop use; required GitHub, terminal or installed-integration faults
and first-launch guidance retain the shared attention predicate. Dismissals are not reset.

Setup uses its existing HTTP snapshot and explicit Re-check owner, not `SettingsStatus` or SSE.
No new runtime discovery service, settings comparator, persisted runtime preference or global
Node selection is introduced. Binary update availability continues through the existing desktop
update snapshot and Application updates panel, including unavailable assets.

## Verification and R2 handoff

`node --import tsx scripts/verify-owned-runtimes.ts` requires a successful build. It executes the
shipped Claude and Codex reports against a synthetic loopback receiver, MCP and Pi bridge
handshakes, statusline delegation, Pi installer and resume check using real local Electron.
It uses a checkout pinning Node 18, first absent host commands and then recording traps for
node/npm/npx. It does not contact a model or touch an operator's app/config/state.
Focused tests cover source installs, existing-registration repair, custom commands, disabled
entries, quoting, repeat repair and concurrent publication. Browser coverage exercises Setup,
real repair action feedback, Pi installation and the existing migration UI. Both OS color
preferences are checked; the dashboard remains intentionally dark-only.

R2 consumes this inventory and the registered focused, bundled-runtime and browser evidence.
Use the following combined checklist with the exact signed inputs required by
[the forward-rollout contract](plans/desktop-without-system-node/forward-rollout.md#r2-subsequent-stablealpha-updates-and-recovery):

| Criterion | Signed journey to record |
| --- | --- |
| NC-1 | R1's retained renamed signed baseline, fresh install/launch and schema-1 source migration; personal, system and custom destinations. |
| NC-2 | Later renamed appNaming-capable stable and exact-SHA alpha targets containing Phase 5; verify installed identity and zero host-runtime hits. |
| NC-3 | Corrupt/truncated/substituted/unavailable assets, wrong signer/architecture/protocol, cancellation before shutdown, helper/receipt/readiness failure and interrupted replacement. Before commitment, restore exact prior app/receipt; after commitment retain forward/manual recovery. |
| NC-4 | Scope, state ownership, receipt bytes, same-folder rename, collisions/races, supported relocation, login preference and integration path repair. Never open live operator state. |
| NC-5 | Execute every owned integration above on the signed target: Claude/Codex hooks, MCP handshake, statusline with/without saved inner command, Pi install/load/bridge, resume guard and existing-registration repair. Repeat with absent commands and traps; test source/custom/third-party paths independently. |
| NC-6 | Inspect Setup runtime labels, optional external Node, remaining required warnings, first-launch guidance, repair feedback, update progress, retry and recovery guidance. Register inspected screenshots. |

Record exact commits, release identities, asset IDs/hashes, signer/notarization/quarantine results,
receipts and state ownership in the release run. Preserve baseline bytes privately. Local Electron,
mocked native verification and browser fixtures prove neither signed installation nor signed
updates/recovery. Unavailable newly produced signed assets leave R2 outstanding, not an
implementation handoff dependency. PR #1214 remains held and is never merged independently.
