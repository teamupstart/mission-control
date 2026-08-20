# Phase 1: Freeze the base and prove a detached lease

## Outcome and value

Prevent a scheduled task from inheriting a previous occupant's Git branch. Ordinary unpinned tasks freeze a freshly fetched remote-default commit before provisioning, and every native worktree is proven exact, clean, and detached before it is leased or returned to the warm pool.

This directly prevents the investigated failure in which a reasonable agent branch rename was interpreted as an ownership change because the task had started on an unrelated feature branch.

## Entry criteria and dependencies

- Direct dependency: the planning session's pull request containing `plan.md`, `phased-plan.md`, and this phase file must merge.
- Read first:
  - `docs/plans/reused-worktree-reset/plan.md`
  - `docs/plans/reused-worktree-reset/phased-plan.md`
  - `docs/worktrees-and-checks.md`
  - `docs/agent-guides/architecture.md`
  - `docs/agent-guides/change-contracts.md`
- Preserve unrelated worktree changes and inspect `git status` before editing.

## Scope

- Resolve ordinary TaskDispatcher bases from a freshly fetched remote default before provisioning.
- Preserve exact caller-supplied pinned bases.
- Pre-resolve primary and attached-repository bases before taking the first worktree.
- Force-detach reused native slots at their exact requested SHA without moving or deleting the prior branch ref.
- Observe and require detached state at acquisition and Return verification gates.
- Add focused regression coverage and update worktree lifecycle documentation.

## Non-goals

- Do not change task/session database schemas or wire contracts.
- Do not weaken or special-case registry work-episode ownership rotation.
- Do not repair the already cancelled task or stop its session.
- Do not delete prior local branch refs or ignored warm caches.
- Do not change ensemble snapshot restoration semantics.
- Do not add UI, settings, or Playwright coverage unless implementation actually changes a visible surface.

## Repository findings and inherited contracts

### Dispatch

`TaskDispatcher.dispatch()` currently verifies only an explicit `options.baseSha`. `provisionAll()` passes that SHA to the primary repository and `null` to every attached repository. The exported `provisionWorktree()` then freezes local `HEAD` for every null base.

The compatible design is to add dispatch-level base resolution, not to redefine the low-level helper:

- Production scheduled tasks resolve each repository base before `provisionAll()`.
- `provisionAll()` receives an exact primary SHA and exact per-attached-repository SHAs.
- `provisionWorktree()` continues to accept null for direct/local callers and freezes local `HEAD` in that case.
- A supplied primary pin remains the primary repository's base; attached repositories resolve their own remote default because one repository's SHA has no meaning in another.

### Native allocator

`NativeWorktreeGit.add()` uses `git worktree add --detach`. `NativeWorktreeGit.reset()` currently delegates directly to `resetWorktreeToCommit()`, which hard-resets, runs `clean -fd`, and verifies the SHA. A hard reset on an attached branch moves the branch tip and keeps the branch checked out.

The pool-specific reset must detach first with a forced exact checkout, then invoke the existing reset/clean helper. This preserves the old branch ref and makes the destructive file reset operate in detached HEAD. Mutation uncertainty remains an unknown outcome.

### Verification

`WorktreeInspection` currently returns canonical path, exact HEAD, dirty state, and common Git directory. Add a detached boolean. A symbolic-ref probe has three meaningful outcomes:

- exit 0: attached, with a branch name;
- the expected Git exit for no symbolic ref: detached;
- timeout, overflow, signal, or another unexpected result: unknown/error.

Both manager verification sites must require `detached === true` before their compare-and-swap transition completes.

## Implementation steps

### 1. Add dispatch-time base resolution

In `src/server/dispatcher.ts`, add a focused helper that returns a full frozen SHA for an ordinary unpinned task repository.

1. Probe whether `origin` is configured in the repository.
2. If it is absent, call the existing local `headCommit()` path and fail if no full commit can be resolved.
3. If it exists, run `git fetch origin` with the network timeout already used for Git fetches.
4. Treat an unknown, timed-out, overflowed, signalled, or nonzero configured-origin fetch as a dispatch error. Do not fall back to local HEAD.
5. Resolve the remote default with the existing `remoteDefaultRef()` rules, then resolve its commit to a full SHA and verify it is a commit.
6. Keep explicit `options.baseSha` on the existing `verifyPinnedBase()` path and do not fetch the remote default for that primary repository.

Resolve the complete base map before provisioning:

- primary: explicit verified pin when supplied, otherwise ordinary resolver;
- each attached repository: ordinary resolver for that repository;
- deduplicate identical repository roots before fetching if the task model can contain them, or preserve a deterministic sequential resolution order to avoid competing fetch locks.

Pass those exact SHAs through `provisionAll()` into every `provisionWorktree()` call. Leave the direct-call null behavior and `headCommit()` fallback inside `provisionWorktree()` intact.

### 2. Extend native inspection with detached state

In `src/server/worktrees/git.ts`:

1. Add `detached: boolean` to `WorktreeInspection`.
2. Probe `git symbolic-ref --quiet HEAD` or an equivalent exact Git question during inspection.
3. Distinguish the expected detached exit from command uncertainty and real failure.
4. Include detached state in successful inspection results.

Update injected fakes and test fixtures that construct `WorktreeInspection` values. Do not infer detachment from the stored branch or from `rev-parse --abbrev-ref` text.

### 3. Detach as part of native reset

In `NativeWorktreeGit.reset()`:

1. Retain the exact physical-directory verification.
2. Run a forced detached checkout at the requested full SHA before the shared hard-reset and clean helper.
3. Classify command uncertainty conservatively and include the failing Git operation in the bounded reason.
4. Invoke `resetWorktreeToCommit()` after detaching to retain exact-HEAD verification and the existing `clean -fd` cache contract.
5. Confirm detachment before returning success, either directly in reset or through a shared exact probe that reset and inspect both use.

Do not add detachment to `resetWorktreeToCommit()` because `restoreSnapshotIntoWorktree()` and session snapshot restoration use it outside pool lifecycle policy.

### 4. Enforce the invariant in manager state transitions

In `src/server/worktrees/manager.ts`, add detached state to both exact verification gates:

- materialization before `finalizeLease()`;
- Return before `completeRelease()`.

Update the failure text to name detached state. Preserve existing quarantine behavior, occupancy rechecks, lease compare-and-swap ordering, and the Return fetch of the remote default.

Do not finalize a lease merely because reset reported success. The independent inspection remains the durable proof immediately before the state transition.

### 5. Add regression coverage

Use real temporary Git repositories where branch attachment, branch refs, remote advancement, and detached HEAD matter.

In `test/worktree-manager.test.ts`:

- acquire a slot, create or attach an old feature branch and upstream in the slot, release or simulate availability, then reacquire;
- assert the slot path is reused, `git symbolic-ref --quiet HEAD` reports detached, returned `branch` is null, and HEAD equals the requested SHA;
- record the old branch's SHA before reset and prove the ref still points there after reset;
- extend the warm-cache reset case to assert Return and reacquisition remain detached;
- inject an attached inspection result or unknown detached probe and prove quarantine prevents finalization.

In dispatcher-focused tests:

- create a bare or local origin whose default advances while the main checkout remains stale, and prove an ordinary task base resolves to the fresh remote SHA;
- prove a configured-origin fetch failure occurs before provisioning or spawn;
- prove a repo with no origin resolves local HEAD;
- prove an explicit pin wins without being replaced by the newer remote default;
- prove all attached-repository bases are resolved before the first provision call, and a later repository failure leaves no lease;
- retain the existing low-level `provisionWorktree()` null-base test because that compatibility is intentional.

Add or extend a registry/task integration case proving a detached initial episode (`branch = null`) adopts the first observed feature branch without task cancellation or binding deletion. Do not change the registry rule to make the test pass.

### 6. Document the final contract

Update `docs/worktrees-and-checks.md` near Native pools and Return:

- ordinary scheduled tasks freeze a freshly fetched remote-default commit before provisioning;
- explicit pins bypass that selection;
- a genuinely origin-less repository freezes local HEAD, while failure to fetch a configured origin aborts dispatch;
- native acquisition and Return independently prove detached HEAD;
- ignored caches survive pool reset.

Do not restate the test preload command outside `AGENTS.md` beyond the phase's verification section.

## Data, API, migration, and compatibility

- Persistence: no schema or migration changes.
- API and shared types: no browser wire changes. `WorktreeInspection` is a server-internal interface.
- Existing pooled slots: repaired on next Return or acquisition because both paths use the corrected reset and detached verification.
- Pinned bases: exact SHA behavior remains unchanged.
- Direct provisioning and local repositories: low-level null-base behavior remains local HEAD; production TaskDispatcher supplies the new remote-default SHA.
- Git branches: prior branch refs are preserved. Only checkout attachment changes.
- Warm caches: ignored files survive because cleaning remains `git clean -fd`.
- Failure behavior: configured-origin fetch failure and detached-state uncertainty fail before agent launch; pool ambiguity quarantines rather than falls back.

## Tests and verification

Run focused tests first:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/worktree-manager.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/dispatch-pinned-base.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/multi-repo-provisioning.test.ts
```

Run any additional focused registry/task test file changed by the implementation with the same preload. Then run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

If a visible UI surface changes unexpectedly, add the required Playwright spec, rebuild, and run `npm run test:e2e`. Otherwise no E2E run is required.

## Merge and exit criteria

- All scoped behavior, tests, and documentation land in one reviewable pull request.
- Ordinary scheduled tasks use a freshly fetched remote-default SHA when origin exists.
- Explicit pins and direct low-level provisioning keep their documented behavior.
- Reused native slots cannot finalize a lease while attached to any branch.
- Return cannot mark a slot available while attached.
- Old branch refs and ignored caches are preserved.
- The focused tests and repository gates above pass.
- The pull request documents any justified deviation from this proposed route.

## Downstream handoff

There are no later phases. After this phase merges, future work may rely on these contracts:

- a task-owned native lease begins detached;
- `baseSha` records the exact frozen dispatch base;
- ordinary TaskDispatcher base policy prefers a fresh remote default;
- pool reset never deletes ignored caches or prior branch refs;
- branch-to-branch registry ownership rotation remains strict.

Future work must not silently restore local-HEAD selection for scheduled tasks, infer detachment from branch strings, or weaken quarantine on unknown Git outcomes.

## Cross-phase audit record

- 2026-08-20: Reconciled the source plan with direct `provisionWorktree()` call sites. Remote-default policy remains in TaskDispatcher so low-level local-only callers stay compatible.
- 2026-08-20: Confirmed one phase owns every source-plan requirement. No earlier or later contract exists to reconcile.
- 2026-08-20: Confirmed the shared ensemble reset helper remains unchanged and registry ownership rotation remains outside scope.
