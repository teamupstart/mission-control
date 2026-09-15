# Phase 1: User defaults and launch identity

## Outcome and value

Fresh personal installations use `~/Applications/Mission Control.app`, and existing system/custom installations remain operable. A packaged app verifies which installed bundle its receipt describes, allowing a capable retained system copy to open the user's canonical personal app without updating the wrong bundle.

This is an independently useful install/compatibility change. Automatic relocation is Phase 2's outcome. Read [plan.md](plan.md) and [phased-plan.md](phased-plan.md) first. The phase is the proposed route; adapt implementation details to current code and explain deviations in the PR without changing the approved goal.

## Entry criteria and repositories

- Direct prerequisite: this planning session's PR has merged and the three referenced Markdown paths resolve on the default branch.
- Repository: `teamupstart/mission-control` only, using the task's issued checkout. No additional repositories or sibling PRs.
- Read root `AGENTS.md`, `.agents/memory/MEMORY.md`, `docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`, `docs/desktop-and-packaging.md`, and `e2e/README.md` before changing their subsystems.
- Inspect Git status, preserve unrelated work, and use the issued feature branch. Do not use ai-conductor skills.

## Scope and non-goals

Own R1-R2 and D1, plus the prerequisite portions of R4, R7, and R8 identified in the index. Include focused tests, runtime evidence, and documentation with the behavior they support.

Do not implement relocation, create a migration journal, rewrite existing integrations, delete the system app, move state, alter CI/release/signing policy, or enable a future migration UI. Do not add a second installer/swap implementation.

## Findings and contracts this phase owns

At the planning baseline, `scripts/app-bundle-swap.mjs` exports one `DEFAULT_APPS_DIR` used both by the install CLI and `privilegedBundleSwapCommand`. The module travels beside the detached helper, so it imports only Node built-ins. `scripts/install-app.mjs` handles full and staged installations through `swapAndRecord`, while `Makefile` uses a separate destructive copy for developer installs.

The receipt is schema 1 and includes optional `installedCommit`; validation/writing live in `src/shared/install-receipt-schema.mjs` and `src/shared/install-receipt.mjs`. Preserve their existing I/O boundary, and place any new Node-only policy modules in `scripts/` or a Node-owned source directory rather than extending Node imports into browser-safe shared code.

Publish these contracts once:

1. **Receipt policy:** optional `installScope: "user" | "system" | "custom"`. Missing means legacy. Unknown values are invalid under the normal malformed-receipt behavior. Preserve optional fields through installer rewrites and rollback. No schema-number bump is needed for this additive field.
2. **Explicit intent:** proposed `--scope user|system` selects and records policy. Reject combination with `--apps-dir` before mutation. The existing `--apps-dir` remains a transport override and never, by itself, proves an explicit system opt-out.
3. **Legacy preservation:** an old helper updating a valid legacy system receipt through `--apps-dir /Applications` leaves `installScope` absent. A matching receipt's explicit policy survives subsequent updates. A fresh noncanonical override is custom. Default fresh personal installs record user.
4. **Path/elevation:** runtime personal default and fixed system allowlist are distinct. User/custom failures never elevate or silently choose a system destination. Validate resolved aliases as well as lexical paths.
5. **Identity:** normal managed startup requires the running bundle's canonical path to match its receipt, with embedded commit equality when the receipt carries it. For older receipts without it, keep version/path compatibility; do not invalidate all legacy installs. A mismatched copy is updater-disabled unless it takes the narrowly validated system-to-personal redirect.
6. **Redirect:** only the exact system product bundle may redirect to this account's canonical personal product bundle, named by a trusted valid committed receipt and matching its recorded identity. The target cannot equal the source or loop. Never execute an arbitrary receipt path. Missing/invalid targets stop with actionable recovery guidance.

## Implementation steps

### 1. Destination policy and receipt compatibility

Update `scripts/app-bundle-swap.mjs` so privileged installation and restoration retain the exact `/Applications/Mission Control.app` allowlist and matching prompts. Introduce a shared Node-side policy function for choosing/validating the personal default and explicit locations; keep its dependencies safe for the detached helper if it is copied there.

Extend receipt schema validation and its declaration file if present for `installScope`. Update `scripts/install-app.mjs` parsing, usage, destination selection, and `swapAndRecord` policy preservation. Existing receipts with no destination option retain their path; absent receipt defaults to the signed-in user's personal folder. Resolve conflicting or invalid options before expensive work.

Automatically create only the canonical personal Applications directory on a real installation, after dry-run/stage-only branching. Refuse a file in its place, a symlink escape, a foreign owner/alias, and an unwritable target with a clear diagnostic. Do not require a manually created directory for the ordinary new-user path. Keep explicit custom destination creation opt-in by retaining the current requirement that it exists.

### 2. Developer and DMG defaults

Change `Makefile`'s developer install destination to the same personal policy and preserve a documented explicit override. Call the existing sibling-staging swap through a small Node caller rather than `rm -rf` followed by `cp`. The developer path installs the current packaged worktree and does not touch the managed receipt or updater-owned clone.

In `electron-builder.yml`, explicitly configure DMG contents as the application plus an offline installation Read Me produced from a checked-in source. Remove the automatic `/Applications` alias; do not replace it with a build-user or literal-tilde link. Keep both current package targets, identity/signing settings, `asar: false`, and satellite files. The Read Me explains unmanaged copying to user scope and the managed command for managed updates. This limited packaging edit is in scope; release workflows are not.

### 3. Running bundle classification and retained-copy launch

Add a testable classification seam near `src/main/bundle-version.ts`/`src/main/updater.ts`, consumed by `src/main/index.ts`. Detect normal managed, unmanaged, mismatched, and validated redirect states before daemon startup. Integrate redirect before the ordinary single-instance lock so the old app cannot acquire the lock and intercept the target's launch. Handle launch failure and cycles explicitly.

Apply the identity result to `UpdateController.start()` so a mismatched receipt never authorizes updating another bundle. Revalidate before applying an update, since another process can replace the receipt/bundle after startup. Preserve current architecture, node-runtime, canonical repository, and missing/newer-receipt checks.

Exercise the existing Electron lifecycle for opening a target and exiting a source; do not instantiate a second daemon or add alternate state ownership. If the target is already running, opening it should reveal its existing instance. Use the executable registry/boundaries for any new subprocesses.

### 4. User-facing copy and documentation

Remove inaccurate unconditional `/Applications` claims from `src/shared/update-copy.ts`; use truthful location-neutral in-place update copy for this phase or an existing validated target projection. Keep `update-dialog.ts`, banner rendering, and Electron consumers aligned. Explain mismatch/recovery in the existing update error surface; do not introduce the Phase 2 migration choice early.

Update README, `docs/setup.md`, the source of `docs/setup-guide.html` if generated, and `docs/desktop-and-packaging.md` where they describe installation. Identify generated inputs before editing, regenerate through their owner, and do not hand-edit generated HTML. Describe personal defaults, preserved existing locations, system/custom opt-in, unmanaged developer/DMG behavior, and unchanged state home. Historical planning documents stay untouched.

## Compatibility and data details

The receipt field is additive and absent in old receipts. Ordinary update handoff flags remain accepted with identical meaning. No source/destination split or new journal appears in this phase. The running bundle and receipt are never silently rewritten to match one another when identity checks fail.

Manual copying to a different location remains insufficient to update a managed receipt. The redirect only follows a receipt already committed by a managed installation; it does not infer a migration from finding two apps. Preserve existing integration paths in this phase.

## Tests and verification

Add focused cases to `test/install-app.test.ts`, `test/install-receipt.test.ts`, `test/updater.test.ts`, and `test/desktop-packaging.test.ts`; add a focused startup classification/redirect test if existing seams cannot express it. Test the real filesystem with temporary directories for creation and alias cases and injected process ports for launch behavior.

Minimum cases: default creation, file collision, personal symlink to system, custom directory missing, dry-run/stage-only no change, spaces/non-ASCII, system-only privileged allowlist, old-helper legacy preservation, explicit policy preservation, no receipt creation for developer install, failed developer copy retaining the old bundle, matching/mismatching/absent commit identities, target missing, redirect loop refusal, and already-running target.

Use the exact single-file loader command from root `AGENTS.md`, naming the changed test files. Do not omit its isolation preload. Run:

```sh
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/update-banner.spec.ts e2e/specs/update-dialog-theme.spec.ts --workers=1
npm run package
```

Extend these E2E specs, or add a focused spec under `e2e/specs/`, for the visible copy and mismatch behavior. Assert user-visible wording/actions with role/label selectors, fake all agent binaries, and check newly opened modal insets. Run any added spec explicitly as well as the relevant full UI suite before landing, per root definition of done. In a later CI repair round, run only tests targeted to the repair before pushing.

Inspect the mounted DMG and a packaged personal install in an isolated account/VM: the artifact contains no system alias or builder home; the installed app starts from the personal path; custom/system paths still work; redirect does not create a second daemon. Never use this operator's live app or state for the exercise. Capture exact paths and screenshots as gitignored workflow/PR evidence. A mock filesystem alone does not establish packaged launch behavior.

## Merge and exit criteria

- R1 and R2 work end to end, and baseline system updates continue in place.
- `installScope`, absent-policy semantics, and identity/redirect contracts are documented and covered by focused tests.
- Developer copying cannot destroy the prior app before the new bundle is staged; developer/DMG installs remain unmanaged.
- Required checks, changed-UI E2E coverage, and isolated packaging/launch verification pass. Report unavailable evidence and do not claim that criterion complete.
- Commit only scoped product/tests/docs; exclude reports, screenshots, logs, local state, and credentials. Open a reviewable PR, address valid feedback, resolve conflicts, and monitor CI. Merge requires operator authorization under the task's current policy.

## Downstream handoff

Phase 2 may rely on `installScope` and absent legacy semantics, fixed system elevation, safe personal resolution, unchanged old-helper flags, and validated old-copy redirection. It must not interpret `--apps-dir` as system consent, duplicate policy in update preferences, loosen path validation, or turn a mismatch into silent receipt repair.

Phase 2 adds its pre-start transaction gate ahead of this phase's normal launch/redirect path. It owns actual migration, integration retargeting, and the visible migration choice; this phase never claims those are already delivered.

## Cross-phase audit record

- Compared against the root D1-D4 decisions: personal defaults satisfy D1; automatic migration remains explicitly assigned to Phase 2, preserving D2.
- Kept old helper `--apps-dir` calls legacy-eligible, preventing an accidental opt-out during the compatibility update.
- Kept legacy receipt identity compatible when optional commit metadata is absent.
- Reconciled Phase 2's startup gate with Phase 1 redirect: pending transactions are handled first; only a committed canonical receipt can trigger ordinary retained-copy redirection.
- Final comparison: no migration or skill-writing dependency is required for Phase 1 to be useful and testable. Phase 2 depends on Phase 1, never the reverse.
