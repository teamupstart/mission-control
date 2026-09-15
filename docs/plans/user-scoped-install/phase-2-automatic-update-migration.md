# Phase 2: Automatic update migration

## Outcome and value

An eligible managed system installation moves automatically to `~/Applications/Mission Control.app` when the user accepts an update from a migration-capable app. The update identifies the move before closing, retains the system copy, commits a verified personal receipt, and repairs only the user's existing Mission-owned integrations. Recovery distinguishes a failed pre-commit attempt from a committed install that needs forward repair.

Read [plan.md](plan.md), [phased-plan.md](phased-plan.md), and [Phase 1](phase-1-user-defaults-and-launch-identity.md) first. The phase document is the proposed route, not a rigid implementation specification; adapt to current repository evidence and explain deviations in the PR. The automatic-migration goal and approved decisions remain fixed.

## Entry criteria and direct dependencies

- This planning session's PR has merged.
- Phase 1's PR has merged, with its `installScope`, destination/elevation separation, legacy CLI semantics, and launch classification/redirect tested and documented.
- Repository: `teamupstart/mission-control` only; no additional repository, external deployment, or sibling PR is required.
- Read root `AGENTS.md`, relevant `.agents/memory` entries, architecture/change contracts, `docs/desktop-and-packaging.md`, and `e2e/README.md`. Inspect the actual Phase 1 implementation and use its real exported names.
- A Phase 1 release need not have shipped. The implementation must safely handle an old installed app jumping directly to the final version and receiving capable code in place before its subsequent update relocates.

## Scope and non-goals

Own the complete R3-R9 outcomes and D2-D3. Consume R1-R2 from Phase 1. Include the whole transaction, identity checks, integration repair, user-visible controls, documentation, packaging dependencies, and tests in this merge unit.

No user-data/state-home move; no automatic deletion of the global bundle; no root repair/chown of user directories; no new updater or SQLite writer; no manual-only replacement for automatic migration; no Dock database editing; no enabling absent integrations. Signing, release and CI workflows remain unchanged. A receipt committed by relocation is not automatically downgraded because later startup or integration repair fails.

## Repository findings and inherited contracts

`src/main/updater.ts` creates a detached helper from the running app and hands it `HelperHandoff.appPath`. `scripts/apply-update.mjs` backs up that path, runs the clone's installer with its directory, checks it, records success, and reopens it. The same helper restores the app and receipt on failure. This single-path assumption is the main seam to extend.

`scripts/install-app.mjs` currently combines the swap and receipt write. Relocation must separate target preparation from receipt publication without changing ordinary old-helper behavior. The existing helper lock uses process identity and protects outcome writes; reuse it for relocation and extract its implementation only if additional receipt writers need the same primitive.

`src/main/index.ts` presently takes a single-instance lock before normal startup. Phase 1 adds canonical-copy classification before that. Insert the migration startup gate before both ordinary redirect and daemon creation; an uncommitted target must not be classified as a normal receipt mismatch and redirected back.

`src/main/integrations.ts` owns desktop hook/MCP edits but installs broadly and treats MCP failures as best effort. `src/server/skills/config.ts` and `reconcile.ts` own skill reconciliation and its persisted generation. `src/main/tray.ts` owns the login toggle. Preserve those owners; do not make the detached helper write SQLite or invent a skill installer.

The update wire is in `src/shared/update.ts`, dialogue content/actions in `src/shared/update-dialog.ts`, shared wording in `src/shared/update-copy.ts`, and dispatch through `src/main/update-dialog.ts`, `src/main/index.ts`, and `src/preload/index.ts`. Browser components are `src/web/components/UpdateBanner.tsx` and `UpdateDialog.tsx`. Extend the existing path and exhaustive consumers together.

## Implementation steps

### 1. Specify and test eligibility at the existing updater boundary

Derive migration from Phase 1's validated running identity and receipt: trusted legacy policy, exact system source, canonical personal target, supported source helper and target build. Explicit `installScope: system` or `custom`, noncanonical source, unmanaged/malformed receipt, inaccessible account home, or foreign target is ineligible or blocked with an explanation.

Represent capabilities in immutable packaged metadata or another versioned packaged contract; do not infer support from a mutable clone, a release-note string, or a guessed version threshold. Validate staged target capability with its pinned build identity. If target capability is absent, update in place using the existing contract and explain the transition when relevant. Legacy helpers need no new flags and keep their existing behavior.

Add distinct source/destination fields to the new handoff and parse them strictly in the helper. Preserve old `--app-path` as the same-location invocation, and reject partially specified migration tuples. Target selection is derived from the confirmed plan and revalidated after the helper takes the lock; never accept an arbitrary browser-supplied destination.

### 2. Add a recoverable transaction to the current helper

Use a versioned private journal under the resolved state home. Proposed minimum contents: attempt ID; source and target canonical bundle paths; source/target identity; old and intended receipts; helper process identity; stage; enabled integration inventory; bounded repair results. Do not store raw credentials or whole vendor config files in logs or evidence. If before-state must include sensitive config for recovery, keep it in owner-only local state with bounded retention and never submit it as evidence.

The helper is the sole journal/receipt transaction writer. Target main-process acknowledgment is a separate file/message tied to a random attempt nonce, PID/start identity, bundle commit, and state home. Use existing process/executable abstractions. A matching pathname or `open` exit does not prove target readiness.

Recommended stages are `prepared`, `target-staged`, `target-ready`, `receipt-committed`, `repair-required`, and `complete`; choose one exhaustive validated representation, with each stage's allowed side effects tested. Journal and receipt writes use atomic rename. Readers reject unsupported journal versions without cleanup guesses.

Hold the existing update lock before any journal, receipt, or outcome mutation. Revalidate the original receipt and all path/identity snapshots after acquiring it. Coordinate normal managed installs, system opt-out writes, and retry actions through the same lock or a single delegated owner so they cannot overwrite the receipt mid-migration. A loser reports busy and performs no cleanup, relaunch, or outcome write.

Reuse sibling staging at the personal destination; cross-directory relocation is a copy into a sibling followed by rename there, not an assumed atomic rename across volumes. Leave the system source untouched. Add an internal receipt-deferred install mode to the existing installer (or reuse a testable lower-level entry) that accepts the validated target tuple, verifies the staged bundle, and returns its prospective receipt without publishing it. This mode must not be reachable accidentally through an old helper call. The existing full and `--from-staged` paths continue to publish receipts normally.

### 3. Implement pre-start readiness and the commit boundary

After the old parent exits, launch the new target in the attempt's pre-start mode. That path validates the target's immutable identity and required packaged assets before starting any daemon, session restore, agent binary, or schema migration. Keep ordinary update checks disabled while pending. The old application's shutdown and any still-owned background daemon must settle before allowing normal target startup; never adopt a daemon serving the old bundle's asset paths as proof of successful relocation.

A target acknowledges pre-start readiness through the attempt-bound channel and waits for commitment. The helper verifies the acknowledgment, atomically writes the intended personal receipt with `installScope: user`, then publishes a committed journal marker. The target starts normal runtime only after the durable commitment is established. If marker publication is interrupted after receipt rename, compare the exact intended receipt and verified target identity, finish the commit, and continue forward.

On a pre-commit error, stop only the verified attempt-owned target, restore the prior receipt where needed, preserve the original system app, and relaunch it. Remove only target/staged paths proved to belong to this attempt; retain bounded diagnostics. Neither an unrelated target nor an edited receipt can be deleted as cleanup.

Recovery on every relevant startup checks live helper ownership before touching an attempt. A dead helper's pre-commit attempt may be resumed or safely restored. A committed attempt is resumed forward. Bounded timeout, killed target, reused PID, corrupt journal, missing target, stale acknowledgment, full disk, and receipt write failure must all yield explicit outcomes rather than an indefinite startup spinner.

After commitment, the target daemon may alter the database. Integration/startup failure then keeps the personal receipt and target bundle; the old system copy's redirect continues to select the personal app. Show forward-recovery instructions. Do not claim old-bundle rollback is safe across a changed database schema. Subsequent ordinary personal updates still use the established same-path update/rollback contract.

### 4. Repair only existing integrations and preserve launch preferences

Before quitting the old app, inspect supported integrations and capture the old login preference. Inventory is read-only and failures are visible before the move; unsupported/custom entries are preserved. Use harness capability metadata and existing adapters to discover registrations, rather than a new list of concrete agents in the updater.

After receipt commitment and normal target startup:

- Retarget recognized old-bundle hook commands through the existing shared ownership predicate and surgical JSONC editor. Preserve other commands/comments; compare with inventoried values before writing.
- For each supported harness MCP registration, change only an existing Mission-owned command/script under the old bundle. Preserve custom executable choices and env settings except paths proven to point into the old bundle; account for the Electron-as-Node runtime fallback. Verify the registration by reading it back. Missing CLI, duplicate-registration refusal, or parse error becomes a named repair item, not success. Do not remove a working old registration until replacement can be verified or recovered.
- Let the new daemon reconcile its enabled skill links from the current app root and report the existing reconciler's conflicts. Preserve disabled skills, other people's links, and the persisted generation/reload behavior. The helper never writes skill configuration or SQLite.
- Refresh login registration for the personal bundle using the preserved on/off preference and Electron APIs. Verify the actual path where the platform exposes it. Preserve off, and expose a specific repair instruction when automatic retargeting cannot be verified.
- Leave already-running external agent sessions alone; the retained system bundle keeps their satellite paths available. Explain when a fresh session is needed.

A repair retry changes only unresolved owned entries and never redoes the bundle move. Persist bounded per-surface status under the migration journal's owner through an existing process boundary; do not let the helper and main both rewrite the journal concurrently. After the helper exits, transfer ownership explicitly under the same lock to a short-lived recovery invocation or one defined main-process coordinator. The ownership handoff must be tested; it is not concurrent shared-file writing.

### 5. Connect confirmation, status, and retry through the existing UI

Extend typed update snapshots/dialog content with migration destination facts and repair-required outcomes. Keep shared browser contracts free of Node imports; append persisted identifiers rather than reordering them. Update preload validation and every exhaustive consumer together. Reuse the existing banner/dialog flow and modal shell inset rules.

The ready state says the update moves the app from `/Applications` to `~/Applications` and retains the system copy. **Install and restart** accepts both actions; **Later**, Escape, and backdrop dismiss with no policy or install mutation. **Keep system installation** writes `installScope: system` under the shared receipt ownership rule, revalidates the staged target, and continues in-place updates. A receipt-write failure must not pretend the opt-out was saved or proceed with relocation.

Report committed personal location separately from repair completion. A partial repair shows the affected integrations and a targeted retry/guidance action. The completed message explains retained system copies and updating Dock shortcuts. A browser without the Electron bridge still has no updater controls. Do not expose internal journal stages as unexplained product copy.

### 6. Package, document, and verify the complete transition

Update the helper-copy inventory in `src/main/updater.ts`, packaging resources in `electron-builder.yml`, and bundle smoke expectations for every new detached dependency. New helper modules must run after the original app is gone and without resolving files from that old bundle. Preserve `asar: false`, package identity, signing policy, and existing targets.

Finish Phase 1's operator documentation with automatic eligibility, explicit system opt-out, one in-place transition update for older helpers, same-account state preservation, integration retries, retained global copies, and pre-/post-commit recovery instructions. Name actual shipped controls/commands. Keep the approved planning documents current if the proposed implementation route changes materially, and explain any adaptation in the PR.

## Data, API, and migration compatibility

- Inherit Phase 1's `installScope`; do not introduce a second migration preference in update preferences. Old absent policy remains eligible after an old-helper transition update.
- Preserve receipt schema compatibility and canonical repository trust. Metadata that declares protocol capability belongs to a verified packaged identity. Old-target in-place fallback is deliberate and tested.
- New helper migration flags are additive; old complete same-path argv is unchanged. Partially supplied new flags are invalid. Custom destinations continue in place.
- Journal readers validate version, canonical account/destination, source/target identities, and lock owner before doing work. App startup checks pending transactions before normal receipt mismatch/redirect handling.
- No new database schema is required to relocate a bundle. The daemon still owns its normal upgrades; that is why post-commit migration recovery must not revert the binary automatically.
- Retained global bundles are neither automatically deleted nor relinked. Another account's receipt/settings are not touched. An explicit system installation for that account remains valid.

## Tests and verification commands

Extend `test/apply-update.test.ts`, `test/updater.test.ts`, `test/install-app.test.ts`, `test/install-receipt.test.ts`, update dialog/preload contract tests, and skills tests where behavior changes. Add focused migration journal/startup/integration tests under `test/` using temporary homes and injected OS/CLI ports. Use the exact isolated test command from root `AGENTS.md` with the focused file names.

| Test group | Required demonstrations |
| --- | --- |
| Compatibility | Old helper argv into new installer preserves absent policy and stays system; next capable update relocates; skipping Phase 1's release works; unsupported target/custom/system policy stays in place. |
| Target and trust | Existing foreign target, source/target alias, symlink escape, spaces, malformed/foreign receipt, changed staged identity, unsupported journal version, and root-owned destination fail without overwriting unrelated files or elevating. |
| Commit/recovery | Inject failure and restart at every durable boundary, including receipt renamed before marker. Test stale nonce/PID, target exit, helper crash, lock contention, full disk, no indefinite wait, pre-commit restoration, and post-commit forward repair. |
| Runtime | No daemon or agents before commit, old daemon cannot be adopted as new-location readiness, only the intended target process acknowledges, old-copy redirect has no cycle/second daemon, subsequent personal update/rollback stays personal. |
| Integrations | Existing/absent/custom registrations, unrelated hook JSONC, Electron fallback executable, per-harness command failure, read-back mismatch, concurrent user edit, skills disabled/conflicted, login on/off, and retry idempotence. |
| UI | Correct source/destination copy, accept/defer/system opt-out, policy write failure, repair-required versus complete, retry, theme/inset geometry, and no plain-browser updater. |

Run the following gates after focused behavior passes:

```sh
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/update-banner.spec.ts e2e/specs/update-dialog-theme.spec.ts e2e/specs/update-preload.spec.ts e2e/specs/alpha-updates.spec.ts --workers=1
npm run package
```

Add `e2e/specs/user-install-migration.spec.ts` (proposed name) or extend the existing specs to cover new controls and repair states; explicitly run that spec too. Reuse fake agent/desktop fixtures and role/label selectors. Add modal inset assertions. Run the full relevant UI suite required by root `AGENTS.md` before landing; during later CI/workflow repair, run only focused tests for the issue before pushing, and monitor CI rather than restarting broad local suites.

### Required packaged macOS exercise

Use a disposable account or VM with a fixture state home and fake agent binaries. Do not replace or reconfigure this operator's live installation. Build representative legacy/bridge/target fixtures or use known versions with pinned source identities.

1. Start a legacy managed system bundle and exercise its real same-location update to capable code. Record bundle and receipt identity; verify migration eligibility survives.
2. From capable code, accept a subsequent update and observe actual personal target launch, receipt commitment, preserved state home, and no system write during relocation.
3. Verify hook/MCP/skill paths, login off and on across restart, and an old Dock/Finder launch reaching the personal instance. Verify the retained system bundle still exists and another account's settings were unchanged.
4. Interrupt before commitment and after receipt rename; verify old-state recovery in the first case and forward recovery in the second. Show a repair failure and successful targeted retry.
5. Apply a later update and a forced pre-launch failure at the personal location; verify the established personal update/rollback contract does not return to `/Applications`.

Capture actual paths/identities and focused logs plus visible UI screenshots as gitignored proof. Register them through `submit_workflow_evidence` and attach useful images to the PR. If this environment is unavailable, keep automatic migration disabled and report R9 incomplete; do not substitute mock-only success or mark this phase delivered.

## Merge and exit criteria

- R3-R9 are demonstrated against the merged Phase 1 contracts, including a real packaged transition and personal subsequent update.
- The operator-approved automatic scope, bridge behavior, retained copy, explicit system choice, and forward-recovery boundary are unchanged.
- Every journal stage has a recovery owner; receipt mutation and retry cannot race a live helper; every detached dependency is packaged and copied.
- Partial integrations are visible and retryable, with no newly enabled integration or changed other-account state.
- Required focused checks, typecheck, lint, build, smoke, E2E, and packaged verification pass; documentation matches the implementation. No workflow evidence or local state is committed.
- Open a reviewable scoped PR, address valid feedback, resolve conflicts, and monitor CI. Phase completion waits for its authorized merge; do not merge without the operator's applicable authorization.

## Downstream handoff

There is no third phase. The resulting repository provides personal defaults and automatic update migration as one completed feature. Future changes may rely on receipt-based installed identity and journal ownership, but must not weaken old-helper compatibility, system authorization restrictions, integration ownership, or post-commit forward recovery. Cleanup of the retained global bundle remains an explicit human action.

## Cross-phase audit record

- Re-read the approved root, index, and Phase 1 before drafting. Kept its exact `installScope` absent-policy semantics and fixed system privilege boundary.
- Recovery gate precedes Phase 1's normal launch classifier; a pending target is not mistaken for an unrelated copied app.
- Skill reconciliation remains daemon-owned after commit, resolving the conflict between pre-daemon readiness and reading durable skill settings.
- Explicitly included all receipt writers in lock coordination and separated acknowledgment from the journal writer; post-helper repair transfers ownership rather than adding a concurrent writer.
- R3-R9 have one accountable owner here; Phase 1 contributes prerequisites, not parallel migration behavior. No independent/concurrent merge claim is made.
- Final audit preserves D1-D4 and the retained-system-copy decision. No later phase or undocumented cleanup is required for success.
