# Reset reused worktrees before dispatch

Status: Approved for phased implementation and scheduling

Dashboard decision recorded 2026-08-20: create the phased implementation plan and schedule its dependency-linked task.

## Decision

Before an ordinary unpinned task is launched, resolve a fresh full commit ID from the repository's remote default branch, provision every task worktree at that ID, and require every native pool slot to be clean and detached before its lease is finalized. For most repositories the target is `origin/main`; the implementation must honor `origin/HEAD` so repositories whose default branch is `master`, `release/next`, or another name behave correctly.

Explicit pinned bases remain exact and bypass remote-default selection. This preserves ensemble comparisons, workflow checks, and any caller that intentionally requests a historical commit.

This is not a scheduler collision fix. The investigated task had one exclusive slot lease and a fresh SDK session. The defect was that the reused checkout retained the previous occupant's branch attachment after its files were reset.

## Why this is the right boundary

The documented native-pool contract already says slots are exact-commit, detached worktrees and that Return resets a warm slot to the freshly fetched remote default. The implementation meets only the exact-commit and clean-file portions:

- New native slots are created with `git worktree add --detach` in `src/server/worktrees/git.ts:129`.
- Reused slots call `NativeWorktreeGit.reset` in `src/server/worktrees/manager.ts:659`.
- That reset delegates to `resetWorktreeToCommit`, which runs `git reset --hard`, `git clean -fd`, and exact-HEAD verification without detaching in `src/server/git/ensemble-snapshot.ts:736`.
- Acquisition and Return verify path, repository identity, exact HEAD, and cleanliness, but not detached state in `src/server/worktrees/manager.ts:687` and `src/server/worktrees/manager.ts:898`.
- Unpinned task provisioning currently captures the main checkout's local `HEAD`, not a freshly fetched remote default, in `src/server/dispatcher.ts:1202` and `src/server/dispatcher.ts:1241`.

That mismatch explains the incident: the reused slot reached the requested commit while remaining on `codex/settings-status-hermetic-path`. When the agent renamed the inherited branch, the branch observer correctly treated a non-default branch changing to another non-default branch as a new work episode and invalidated the task binding.

## Required behavior

### 1. Resolve the base before provisioning

Add one task-dispatch base resolver and use it for the primary repository and each attached repository before taking any worktree lease.

- If the caller supplies a pinned full SHA, verify it exactly as today and use it unchanged.
- Otherwise, run a bounded `git remote` listing. Only a successful listing that omits the exact name `origin` may establish that the repository has no origin. A timeout, spawn failure, overflow, signal, or nonzero probe result fails dispatch.
- With an `origin`, fetch it, resolve its remote default ref through the existing `remoteDefaultRef` rules, and freeze the result to one full SHA.
- If a configured `origin` cannot be fetched or its default cannot be resolved, fail dispatch before any worktree is leased or any agent is spawned. Do not silently use a stale local branch.
- If the repository genuinely has no `origin`, retain local-repository support by freezing the current local `HEAD`. This is the only unpinned fallback.
- Resolve all repository bases before provisioning the first tree so a multi-repository task stays all-or-nothing.

The exact resolved SHA, not the symbolic string `origin/main`, is passed to both the native allocator and the disposable Git fallback and is persisted as the task repository's `baseSha`.

### 2. Make native reset detach by contract

Change the native allocator's reset operation, not the shared ensemble snapshot restore helper.

- Detach the checkout at the requested full SHA with a forced Git checkout suitable for a destructive pool reset.
- Run the existing hard-reset and `clean -fd` sequence after detaching so tracked and nonignored untracked residue is removed while ignored caches remain warm.
- Preserve the previous local branch ref. Reusing a pool slot should release the branch from the checkout, not move or delete that branch name as a side effect.
- Treat an uncertain or partially applied Git mutation as an unknown outcome so the slot is quarantined rather than leased twice.

Keeping this behavior in `NativeWorktreeGit.reset` avoids changing ensemble artifact restoration, which uses the shared helper for a different operation and does not promise to detach the selected winner's session.

### 3. Verify detachment before lease and availability

Extend native worktree inspection with a detached-HEAD fact obtained from Git, then include it in both manager gates:

- After creating or resetting a slot, require canonical path, matching Git common directory, exact requested HEAD, clean status, and detached HEAD before `finalizeLease`.
- After Return resets to the freshly fetched remote default, require the same facts before `completeRelease` marks the slot available.
- Quarantine on a failed or unknown detached-state observation. No task row should receive the worktree and no agent should start.

This acquisition-time check repairs warm slots left by older builds on their next use. It also makes the invariant executable instead of relying on comments.

### 4. Keep ownership rotation strict

Do not weaken the registry rule that rotates ownership when one real feature branch changes to another. That rule protects against genuine branch takeover. The allocator should prevent a new task from inheriting a feature branch, and the pre-lease detached-state gate should fail closed if that prevention ever regresses.

## Dispatch flow after the change

1. `TaskDispatcher` verifies an explicit pin or fetches and freezes each repository's remote-default SHA.
2. `WorktreeManager` reserves an exclusive slot for that exact SHA.
3. `NativeWorktreeGit` creates or force-detaches and resets the slot at the SHA.
4. `WorktreeManager` verifies identity, exact HEAD, clean status, empty occupancy, and detached HEAD, then finalizes the lease.
5. Only after every repository is provisioned does Mission Control persist the task resources and spawn the agent.
6. The agent starts with `gitBranch = null`; its first feature branch becomes the same work episode rather than an ownership change.

Any failed fetch, reset, or proof stops before step 5. Explicit pinned dispatches enter step 2 with their supplied SHA and do not fetch the remote default.

## Implementation surface

| Area | Planned change |
| --- | --- |
| `src/server/dispatcher.ts` | Resolve and freeze bases before provisioning; use remote default for ordinary tasks, preserve exact pins, and pre-resolve all attached repositories. |
| `src/server/worktrees/git.ts` | Make native reset force-detach at the exact SHA; report detached state from inspection. |
| `src/server/worktrees/manager.ts` | Require detached state before finalizing a lease and before marking a returned slot available. |
| `test/dispatch-pinned-base.test.ts` and dispatcher tests | Add task-dispatch remote-default coverage while retaining the low-level provisioner's local-HEAD default and explicit-pin coverage. |
| `test/multi-repo-provisioning.test.ts` | Prove each unpinned repository resolves its own remote default before any tree is taken. |
| `test/worktree-manager.test.ts` | Reproduce a branch-attached warm slot, then prove Return and reacquisition leave it clean, exact, detached, and cache-warm. |
| `docs/worktrees-and-checks.md` | State the base-selection rule, missing-origin exception, fetch-failure behavior, and detached verification. |

No database schema, wire contract, settings UI, or ownership-episode rule needs to change. This is server-side lifecycle behavior, so no Playwright spec is required unless implementation introduces a new visible UI state.

## Regression tests

The implementation is complete only with focused tests for these cases:

1. A reused native slot is deliberately attached to an old feature branch with an upstream. Acquisition detaches it at the requested SHA and returns `branch: null`.
2. Native reset preserves the old branch ref instead of moving or deleting it.
3. Return fetches the remote default, removes nonignored residue, preserves ignored caches, and leaves the available slot detached.
4. A detached-state probe failure or an attached result quarantines the slot and prevents lease finalization.
5. An ordinary task whose local `main` is stale starts from the newly fetched `origin` default SHA.
6. A configured-origin fetch failure fails before any worktree or agent is created.
7. A repository with no `origin` still starts from its frozen local `HEAD`, but a failed or unknown origin-existence probe fails closed instead of taking that fallback.
8. An explicit pinned base remains selected even when the remote default advances.
9. Each repository in a multi-repository task resolves its own base, and a failure in any repository leaves no lease behind.
10. After a detached task launch, observing the agent's first feature branch updates the existing work episode without cancelling or unbinding the task.

The exported low-level `provisionWorktree()` helper retains its current rule when called without an exact base: freeze the current local `HEAD`. Production `TaskDispatcher` owns the new remote-default policy and passes the resolved SHA into that helper. This keeps local tooling and direct provisioning compatible while making scheduled tasks deterministic.

## Validation

Run the focused tests with the repository's mandatory state preload, followed by the server gates:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/worktree-manager.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/dispatch-pinned-base.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/multi-repo-provisioning.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

## Delivery shape

This should ship as one atomic implementation task. Base resolution, detached reset, manager verification, tests, and documentation form one invariant; splitting them would allow an intermediate merge where the allocator still launches a task from a state the dispatcher or registry interprets incorrectly.

The implementation task should not alter current live task/session records, delete branch refs, remove worktrees, or retroactively repair cancelled tasks. Operational repair of the investigated task is separate from preventing recurrence.

## Established and not established

Established from the live records and source:

- The affected task had exclusive allocator ownership, not a shared live worktree.
- Its reused checkout started on an inherited feature branch.
- The agent's branch rename preceded task cancellation and binding deletion by 11 seconds.
- The allocator reset and verification paths do not detach or prove detachment.
- Return already fetches the remote default, while ordinary acquisition can replace that commit with the main checkout's local `HEAD`.

Not established by this planning pass:

- The proposed changes have not been implemented or test-reproduced yet.
- No benchmark was run for the added fetch latency. The plan minimizes it to one fetch per unpinned repository per dispatch and performs it before leasing.
- No attempt was made to repair the already cancelled task or close its orphaned session.
