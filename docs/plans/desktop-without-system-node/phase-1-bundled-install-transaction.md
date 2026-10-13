# Phase 1: Bundled detached installation and compatible receipts

Read [plan.md](plan.md) and [phased-plan.md](phased-plan.md) first. This is the proposed route, not an immutable specification: preserve the outcome and contracts, adapt to the repository, and explain deviations in the PR. Repository: mission-control only.

## Outcome and entry criteria

Apply an already prepared app through a helper that survives parent exit and replacement without host Node. Preserve install identity, receipts, relocation and recovery. The existing source build remains usable; the binary publisher and downloader are later phases.

Direct phase dependencies: none. The planning session's artifact-publication dependency must be satisfied. Start from main containing these documents; read AGENTS.md, the architecture/change contracts, desktop packaging guide and existing migration tests. Confirm that no concurrent change already owns the same transaction.

## Scope and non-goals

Own contracts C1-C3: binary metadata/manifest validation, source/binary receipt compatibility, packaged helper runtime and a shared staged installation operation. Keep UI behavior unchanged unless an actionable recovery message is required, in which case add its Playwright coverage in this phase. Do not publish release assets, enroll DMGs, replace the Bash installer, remove Setup requirements, or configure credentials.

## Findings to preserve

- `spawnDetachedUpdateHelper` currently copies `UPDATE_HELPER_FILES` but launches an external Node; `runApplyUpdate` still invokes the source clone's installer even when a staged bundle exists.
- `install-app.mjs` owns `isolateStagedBundle` and private `swapAndRecord`; `app-bundle-swap.mjs`, `update-lock.mjs`, `install-migration.mjs` and `migration-runtime.mjs` already own the safety boundaries.
- Schema 1 requires `sourceClone`, which can be a retained bundled installer directory. `install-identity.ts` and migration validators compare exact bundle/receipt identity. Existing migration journals carry schema-1 receipts and must remain readable.
- Relocation acknowledges a nonce, PID/start identity, commit, state home and destination before receipt commitment. It resumes forward after commitment instead of automatically reopening old code against migrated data. Ordinary in-place apply lacks this complete readiness boundary.

## Runtime flow

Prepared app -> Private complete runtime -> Shared staged transaction -> Readiness / receipt commit -> Recovery or launch.

<!-- flow-diagram -->

## Implementation order

1. Add focused failing tests for a complete staged apply with external Node/npm/npx traps, exact receipt rollback, and source/schema-1 compatibility. Extend the existing `apply-update`, `install-app`, `install-receipt`, `install-migration` and `migration-runtime` suites before changing ownership.
2. Define the shared, browser-safe binary contract in one proposed `src/shared/binary-distribution.mjs` with matching `.d.mts`. Keep bare-Node scripts able to import it. Validate bounded data rather than accepting arbitrary URLs or version strings. The manifest fields below are the contract shape to settle in this phase, not a second schema kept in documentation.
3. Evolve `install-receipt-schema.mjs` and its declarations to distinguish legacy schema 1, schema-2 source installation and schema-2 binary installation. Update every receipt reader found by symbol search, including `install-receipt.mjs`, `install-identity.ts`, `install-destination.mjs`, migration validators and retained-installer cleanup. Keep existing source writers on schema 1 while old helpers may need them; new consumers can accept schema-2 source receipts without forcing an unnecessary migration.
4. Extract the existing staged copy/verification/swap/receipt operation into a proposed `scripts/install-staged-app.mjs` owner called by both `install-app.mjs` and `apply-update.mjs`. Preserve the existing swap primitive and lock. Pass an explicit accepted source or verified binary descriptor; a binary operation never executes `sourceClone/scripts/install-app.mjs`. Do not retain two implementations of receipt publication, destination policy or rollback.
5. Introduce a small pure owned-runtime resolver in a suitable shared `.mjs` module, taking explicit runtime context and absolute executable path. Preserve `resolveMissionMcpRuntime` behavior through the shared owner without importing server state into Electron main. Copy the complete current app to a private attempt directory for helper execution. In bootstrap consumers a verified candidate app may supply this runtime instead. Keep runtime, candidate, installed destination and backup distinct.
6. Extend the existing handoff to carry the explicit install descriptor, accepted bundle revision/identity, state home, source process identity and helper protocol. Support existing source handoff fields during transition. Make helper readiness observable before requesting app quit. Set `ELECTRON_RUN_AS_NODE` only on owned script launches and remove it for GUI app launches. Pin nested children to the same executable; do not resolve `node` or `npm` from PATH.
7. Extend the current journal/readiness ownership to in-place binary apply. Preserve old relocation journal reads and append-only stages. Use a nonce plus exact process/bundle/state identity, bounded waits and old-daemon exit checks. Reuse the existing startup pre-state entry rather than starting a second daemon or opening SQLite in the helper. Stage and verify the target before commitment; ordinary `open` success is not readiness.
8. Handle disk budgeting, stale attempt cleanup and failures under the existing locks. Check realistic worst-case space for runtime copy, candidate, staging and backup without assuming APFS clones. Delete only positively identified dead attempt resources with no recovery obligation. Preserve backups and diagnostics if outcome/retention writes fail. No automatic deletion of old source caches or compiled installers whose receipt can be restored.
9. Extend `UPDATE_HELPER_FILES`, `electron-builder.yml`, build entry scripts and smoke inventories together for new executable modules. Keep `asar: false`, skills in source form and native addon rename publication. Update `docs/desktop-and-packaging.md` to describe only the behavior now delivered, including source-build preparation's remaining host Node requirement.

## Data, API and compatibility contract

The manifest's initial protocol is versioned separately from receipt and migration protocols. Settle field names in code once: canonical repo, channel, stable tag or null, application version, full commit SHA, `darwin`/`arm64`, bundle identifier, minimum macOS version, helper protocol range and an asset inventory (kind, immutable asset id/name, byte length and SHA-256). Reject duplicates, unknown incompatible protocol versions and inconsistent channel/tag identities.

Signed app metadata contains build identity and supported protocols before signing. External manifest/archive checksums are computed afterward. Never put a digest of the archive containing the metadata back inside that archive. The caller supplies the trusted publisher policy from shipped configuration, not from the downloaded manifest's claim about itself. Authenticity verification is an execution precondition, separate from the pure shape validator.

Schema 2 keeps repo, app path, installed version/commit/time and install-scope semantics. A source form requires `sourceClone`; a binary form requires immutable artifact/manifest provenance and must not invent a clone path. Schema 1 reads as legacy source. Unsupported future schemas fail closed. New binary writes use schema 2 only after the target app's reader/helper support has been established; source-mode behavior remains compatible with existing releases.

The accepted descriptor is immutable for an attempt. Revalidate receipt identity/digest, staged revision, target version/commit, destination and helper protocol at the final mutation boundary. Retain the exact old receipt bytes, not a reconstructed equivalent. Preserve absent scope as legacy, explicit system/custom consent, former canonical repo receipt compatibility, and narrow system-folder elevation.

Receipt commitment remains the recovery boundary. Before commitment, a failed verified target is stopped by process identity and the old app/receipt may be restored. After target state has advanced, backward launch requires proven compatibility or an explicitly reviewed daemon-owned recovery mechanism; unknown means retain recovery material and report forward/manual recovery. No helper copies or restores a live SQLite database. No new DB schema or generic rollback service is required by this phase.

## Tests and verification

Run the repository's isolated single-file command from AGENTS.md for this focused group:

`test/apply-update.test.ts test/install-app.test.ts test/install-receipt.test.ts test/install-identity.test.ts test/install-destination.test.ts test/install-support-cleanup.test.ts test/install-migration.test.ts test/migration-runtime.test.ts test/update-source.test.ts test/mission-mcp-runtime-electron.test.ts`

Add tests for the new pure manifest/receipt union and staged operation, and include those new files in the focused run. Include external-runtime traps, parent exit, original-app rename, helper import closure, PID reuse/unknown identity, concurrent installers, low disk, receipt/outcome write failure, altered candidate, stale helper cleanup and interrupted pre-/post-commit recovery. Verify source preparation and explicit developer install paths still work.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, and the relevant Electron tests with the approval required by AGENTS.md. For any changed visible recovery copy/flow, add and run the corresponding spec under `e2e/specs/` after build. Use an isolated packaged fixture for the complete detached process test, never the operator's installation or live home. An ad-hoc local bundle is sufficient for this phase's mechanics; Phase 2 must repeat against the actual distribution signature before publishing assets.

## Merge and exit criteria

- Existing managed source installs still prepare/apply successfully; previously serialized receipts and journals still open safely.
- A real copied complete app runtime applies a staged fixture with no host runtime invocation, survives parent exit/original-bundle replacement, and records a bounded outcome.
- Binary receipt readers, descriptor validator and common staged-install API are ready for producers and consumers; no binary network entry point is exposed early.
- Exact rollback bytes, destination policy, locks, daemon ownership and commitment behavior are verified. Required checks pass and evidence is registered.

## Downstream handoff

Phase 2 receives C1 and C3 for packaging and signed-runtime qualification. Phases 3-4 consume the same staged installation and schema-2 receipt APIs. They may add transport and enrollment, but must not fork transaction logic, loosen identity checks, widen elevation or reinterpret legacy scope. Phase 5 consumes the pure owned-runtime resolver without changing its treatment of source or adopted daemons.

## Cross-phase audit record

- Compared with root/index: placed receipt, manifest and helper contracts here because every later phase consumes them; the phase delivers a functioning detached staged apply rather than unused schemas alone.
- Signing is deliberately not claimed verified here. Phase 2 owns signed fuse/lifetime proof and cannot advertise a ready artifact without it.
- Reconciled rollback language with the existing receipt-commit boundary. Later phases inherit that boundary rather than adding a post-migration backward launch.
- Final audit: bootstrap supplies a verified candidate runtime when no current app exists; later source-build removal is restricted to packaged update consumers, not developer installation.
