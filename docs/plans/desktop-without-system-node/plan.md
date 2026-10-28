# Desktop installation and updates without system Node

Ordering correction: the rename and compatible binary consumer must land together before any binary installation or upgrade. PR #1214 stays draft and DO NOT MERGE independently. The sole R1/R2 qualification and dependency contract is [forward-rollout.md](forward-rollout.md).

Status: approved direction for phased planning. On 2026-10-13 the operator requested: "use phased plan skill to fully plan and schedule the work". This authorizes the phase plans and dependency-linked backlog tasks. This planning session does not implement the application or provision release credentials. See [the implementation index](phased-plan.md) for the executable task boundaries.

## Approved forward rollout, 2026-10-26

The operator approved starting binary installation with newly produced releases on 2026-10-26. The [forward-rollout contract](forward-rollout.md) owns the baseline, implementation acceptance and release qualification rules.

## Outcome and scope

A supported macOS Apple Silicon user can install Mission Control, launch it, install Mission Control-owned integrations, receive stable and alpha updates, and recover from a failed update without installing or selecting system Node.js, npm, npx, or a local build toolchain.

Electron still embeds Node. The dependency being removed is an operator-managed runtime, not the app's internal engine. Source development and CI still use Node. External agents, Conductor, and user-authored project commands keep their own prerequisites, shown only for the affected feature. This work does not promise that an arbitrary third-party Node program can run without its interpreter.

Preserve user/system/custom destinations, explicit installation scope, managed installation identity, state-home ownership, legacy relocation, receipt rollback, update cancellation, and the stable/alpha channel choice.

## Verified baseline

The original investigation used ce218d2d. Phasing rechecked the implementation at b8d3260e and compared main through 4b9ea92e; the intervening changes do not alter the update/install runtime owners. Implementing phases must refresh against their merged prerequisites.

| Existing owner | Verified behavior | Required change |
| --- | --- | --- |
| src/main/updater.ts and update-build.ts | Select a release tag or main commit and stage a source build | Stage a verified published binary for the selected immutable identity |
| scripts/install.sh | Requires git and node and runs install-app.mjs | Standard binary bootstrap must not invoke node or compile |
| scripts/apply-update.mjs | Runs on external Node and still calls an installer from sourceClone, even for staged bundles | Run with an independent bundled runtime and install staged bytes directly |
| scripts/app-bundle-swap.mjs, update-lock.mjs, install-migration.mjs | Own replacement, locking and relocation/recovery | Reuse these owners; do not create a second transaction or migration implementation |
| src/shared/install-receipt-schema.mjs | Schema 1 requires sourceClone | Add an explicit binary-install receipt shape and retain schema 1 reads |
| src/main/integrations.ts | Prefers any external Node found; falls back to Electron | Use an app-owned runtime for shipped satellites and repair owned registrations |
| src/server/mission-mcp.ts | Dispatched MCP already uses the daemon executable | Preserve this behavior and share its runtime policy without importing the daemon into Electron main |
| .github/workflows/ci.yml and release.yml | Package a DMG as an Actions artifact; Release Please owns stable releases | Publish durable, verified update assets as an additional release step |
| electron-builder.yml | Apple Silicon, asar disabled, ad-hoc signing | Establish distribution signing and notarization before binary rollout |

The existing release plan under docs/plans/release-pipeline-and-auto-updates is historical context. Its statements about source-only updates and ad-hoc distribution are intentionally superseded by this proposal, while the current Release Please owner remains unchanged.

## Proposed architecture

### Build once and distribute the result

Keep Release Please as the owner of stable versions, tags and release notes. A macOS packaging job checks out the exact source identity, builds and tests once, signs and notarizes the app, and publishes a complete immutable asset set in the canonical repository.

Publish an app ZIP for updates and a DMG for manual installation. Define a versioned manifest containing product/bundle identity, channel, version, full commit, platform, architecture, minimum macOS version, asset identity, byte length, SHA-256, and supported updater protocol. Publish the manifest last as the readiness marker. A release object by itself does not mean its binary is ready. Retries verify an identical published set; they must not replace bytes under an identity already offered to clients.

Authenticate release access through the existing GitHub CLI integration in the first implementation. It is a native executable and does not require Node. Keep the canonical repository restriction, credential redaction and explicit repository selection. Public versus private access must work without embedding tokens in URLs or forwarding credentials to arbitrary redirected hosts.

Use SHA-256 for byte integrity, not as a substitute for publisher authenticity. Before executing downloaded code, require the expected Developer ID team, bundle identifier, valid code signature and notarization policy. Confirm the actual team identity and signing credentials as release prerequisites; their availability has not been established in this session.

### Preserve stable and alpha semantics

Stable selects only complete assets for eligible stable releases. Alpha continues to pin the exact main SHA at the time of the offer. Produce commit-addressed alpha bundles in trusted main CI, kept separate from stable release discovery. If the selected commit has not finished publishing, show that its build is pending or unavailable. Do not silently install an older alpha, another channel, or locally compile it.

An alpha publication namespace and retention policy must keep every offered build available long enough to finish or retry. The client never installs a mutable latest pointer as its identity. A verified local staged bundle remains usable if the remote asset later expires; otherwise require a new explicit offer.

### Reuse bundled Node without depending on the app being replaced

Recommended helper host: copy the complete current app into a private, attempt-owned updater directory and launch its executable with ELECTRON_RUN_AS_NODE=1. Keep its full framework layout and signature intact. The runtime snapshot, downloaded candidate, installed destination, and rollback backup are separate paths. Never execute from a bundle that the transaction will rename, overwrite or remove.

A local probe copied the installed app and successfully launched its embedded Node 24.21.0 / Electron 43.7.7 while node, npm and npx on PATH were traps. This verifies copied-runtime launch. It does not yet prove the complete detached transaction on a signed distribution build.

Move the staged install operation out of the source-build installer into the existing shared replacement/receipt owner. Ship its complete dependency closure in the app. The detached helper must never invoke sourceClone/scripts/install-app.mjs, npm, or a Node binary selected from PATH. All nested helper invocations carry the same pinned bundled runtime and required environment.

Keep the helper snapshot until it exits and its outcome is recorded. A later app startup or update attempt can remove only abandoned attempt-owned snapshots after checking process identity and recovery obligations. Budget disk for the runtime snapshot, candidate, staging copy and rollback backup before stopping the app. Use real measured free-space needs; do not assume copy-on-write is available.

A small native helper is the alternative if the signed-runtime snapshot cannot pass the replacement and recovery tests. It requires porting substantial existing recovery logic and is not the default. Copying only the Electron executable is not sufficient because its frameworks are part of the runtime.

### Keep one replacement and recovery transaction

Download, validate, unpack safely, verify the app and stage it while Mission Control remains usable. Extraction must reject absolute paths, traversal, escaping symlinks and unexpected roots, and enforce compressed/unpacked size limits. Cancellation and interrupted downloads must leave the installed app unchanged.

Revalidate the candidate identity, receipt/destination identity and helper protocol at handoff. Acquire the existing update/receipt ownership locks, prepare the independent helper, and prove the helper started before requesting app shutdown. Preserve PID plus start-time ownership and bounded parent-exit waits.

Reuse the existing same-filesystem staging and rename replacement, receipt backup, narrow administrator authorization and failed-update retention. Preserve legacy system-to-user relocation and its integration repair journal. Privilege applies only to the authorized bundle swap, not network access or general helper execution.

Success must include a bounded readiness acknowledgement from the expected new app identity and state home. Do not infer success solely from the OS accepting a launch request. If the new app fails before readiness and before state commitment, stop the exact attempt-owned process, restore the old bundle and exact receipt bytes, and relaunch the prior app. Preserve the existing relocation receipt-commit boundary: after commitment, do not automatically launch an older app against possibly migrated data. A post-state rollback requires verified compatibility or an explicitly reviewed daemon-owned recovery strategy. Preserve recovery material if rollback itself fails.

Coordinate readiness with database ownership and migrations: prove rollback compatibility for the release before distribution. An older app cannot safely resume against an incompatible migrated database merely because its bundle was restored. Where compatibility cannot be guaranteed, a release needs an explicit recovery strategy before it is eligible for automatic distribution.

### First install, receipts and existing users

The normal installation path downloads the signed binary without Node. The Bash bootstrap can use native OS tools and existing gh authentication; it must validate product identity before starting the downloaded app. Manual DMG installation gets a first-launch managed-update enrollment path after confirming the installed destination, app identity and any existing receipt. Running directly from a mounted DMG must lead to installation, not an update that writes into the disk image.

Introduce schema 2 as a discriminated source-install or binary-install receipt. Keep schema 1 readable as the legacy source form. A binary receipt records immutable artifact provenance and app destination without inventing a sourceClone directory. Existing app-identity, relocation, diagnostics and recovery readers must handle both forms. A successful migration writes the new receipt atomically; rollback restores the exact previous receipt bytes.

Older apps cannot acquire new updater code without first upgrading. Publish a standalone binary bootstrap/manual DMG route that replaces an old installation without requiring Node, preserves state and destination, and repairs Mission-owned integration paths. Users whose old updater still has a working Node toolchain may take one normal update, but that is optional, not a prerequisite for migration. Do not delete the old source clone until the new install is committed and no rollback obligation references it; cleanup is optional and ownership-gated.

Keep explicit source-build commands for developers and custom forks. The desktop binary path must not fall back to those commands when a release asset is unavailable.

### Setup and integration behavior

Once the binary lifecycle works, remove the universal system Node requirement from packaged Setup. Show the actual app/daemon runtime as information and keep external runtime problems attached to the feature that needs them. A standalone or adopted daemon must be described accurately; detecting the Electron UI alone is insufficient.

Use a common pure runtime resolver for Mission-owned MCP, hooks, statusline, Pi installation helpers and resume/check wrappers. Enumerate every shipped registration and helper consumer before declaring completion. Never substitute bundled Electron for arbitrary user commands or third-party CLIs.

Repair only Mission-owned entries, preserving unrelated settings, comments, permissions and installations. Installation relocation must update absolute paths through the existing integration migration owner. Existing registrations need a repair/reinstall path; changing the resolver only affects future registrations.

Preserve the append-only node-runtime identifier in persisted contracts even if its packaged universal row becomes absent or informational. Do not rename or reorder stored IDs.

## Flow

Today: GitHub source identity -> local clone and npm build -> staged app -> external Node helper -> installed app and receipt.

Proposed: trusted macOS CI -> signed immutable release assets -> running app downloads and verifies -> private bundled-runtime helper -> atomic app and receipt replacement -> new-app readiness or rollback.

Node and build tools remain on the CI/developer side. Operator machines consume already-built artifacts.

<!-- flow-diagram -->

## Implementation sequence and acceptance gates

The detailed, audited merge units are in [phased-plan.md](phased-plan.md). The operator authorized scheduling these phases on 2026-10-13.

| Phase | Deliverable | Direct prerequisite |
| --- | --- | --- |
| 1 | Bundled detached installation, receipt compatibility and recovery contracts | Planning-session publication |
| 2 | Signed stable and exact-SHA alpha distribution | Phase 1 |
| 3 | Node-free bootstrap, legacy replacement and DMG enrollment | Phase 2 |
| 4 | Binary desktop updates and progress/recovery UI | Phase 3 |
| 5 | Mission-owned integrations, honest Setup and completed Node-free journey | Phase 4 |

Every phase also depends directly on this planning session's publication. This plan keeps the five original work packages but moves the working binary installation route ahead of mass updater transition. Signing proof remains required for each distribution artifact; the first binary release and later update qualification follow the approved forward rollout, independently of implementation merge acceptance. Publication of assets and credential provisioning are future implementation work, never actions of this planning turn.

## Verification matrix

| Criterion | Required implementation and rollout proof |
| --- | --- |
| NC-1: no system Node for first install and launch | Fresh macOS test account/VM with node/npm/npx absent; signed download installs and app/daemon start |
| NC-2: no system Node for stable or alpha update | Packaged old/new app transaction with sentinel Node/npm/npx commands that fail and record invocation; exact target identity installed; no sentinel hit |
| NC-3: safe failure and recovery | Corrupt/truncated asset, wrong signer/architecture, incomplete manifest, low disk, cancel, app refusing shutdown, helper interruption, receipt write failure and new-app readiness failure |
| NC-4: preserve install identity and data | User/system/custom paths, legacy relocation, concurrent attempts, schema 1 -> 2, wrong running bundle, rollback restoring old receipt, database compatibility check |
| NC-5: integrations independent of external Node | Real shipped MCP handshake and hook/helper execution in a checkout pinning old Node, plus repair of old registrations without touching unrelated settings |
| NC-6: honest UI | Playwright covering download/verification progress, pending alpha binary, cancellation, retry, app runtime info and no universal Node Setup gap; modal inset checks if new modals appear |

Use existing node:test suites around updater, apply-update, migration, install identity and receipts, plus the packaged macOS journey. Unit fixtures do not prove Gatekeeper behavior. Real signed NC-1 through NC-5 journeys remain explicit release follow-ups under forward-rollout.md; their missing inputs do not block implementation completion. Keep agent binaries faked in browser tests. For changed runtime/UI code run typecheck, lint, build, smoke and relevant E2E checks; capture focused output and screenshots as gitignored workflow evidence.

## Risks, tradeoffs and unresolved prerequisites

- Distribution signing/notarization: current config is ad-hoc. Confirm the approved Developer ID identity and credential provisioning. Do not bypass Gatekeeper or strip quarantine as an installation recipe.
- Copied runtime: avoids a second runtime implementation but costs extra disk and startup copying. The 329 MB local installed bundle is one measurement, not a capacity guarantee for future releases.
- Signed runtime compatibility: complete copy launch is verified locally; signatures, entitlements and run-as-node fuse settings must pass on the first published artifact; signed update/recovery proof follows using that baseline and later releases.
- Alpha cost: binary builds on main consume macOS CI capacity and introduce publication latency. Show availability honestly and preserve exact-SHA selection.
- Supply chain: checksums detect corruption; signer identity, canonical publication and safe extraction establish the execution boundary. No execution before verification.
- Recovery: bundle rollback is only safe when persisted state remains compatible. Retain the repository's state ownership boundary and establish per-release migration compatibility.
- Third-party tools: this removes Mission Control's host Node dependency. It cannot eliminate dependencies imposed by independent agents, optional pipelines or user projects.
- Delivery scope: no production changes are made by this plan, and no credentials or releases were inspected or modified. Implementation must refresh against main before editing.

## Claim review and sources

Verified: source owners and current policy listed above; copied Electron runtime launch with host commands trapped. Proposed: binary manifests, copied helper lifetime, receipt schema 2, distribution channels and readiness criteria. Unverified release prerequisites: signing credentials, selected Apple team identity and production artifact access; these are explicit gates, not assumed available.

Local evidence: .evidence/setup-node-runtime-findings.txt and the completed command node .tmp/prebuilt-update-runtime-probe.mjs. The probe proves runtime launch only.

Repository references: [desktop lifecycle](../../desktop-and-packaging.md), [change contracts](../../agent-guides/change-contracts.md), [updater](../../../src/main/updater.ts), [detached helper](../../../scripts/apply-update.mjs), [receipt schema](../../../src/shared/install-receipt-schema.mjs), [integration runtime](../../../src/main/integrations.ts), [release workflow](../../../.github/workflows/release.yml), [package workflow](../../../.github/workflows/ci.yml), [packaging](../../../electron-builder.yml).

Primary external references checked during planning: [Electron signing and notarization](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Electron Node execution mode](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node), [GitHub release assets](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28#get-a-release-asset).
