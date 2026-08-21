# Phased implementation: reset reused worktrees before dispatch

Status: Approved and scheduled after publication

## Source of truth

- Approved plan: `docs/plans/reused-worktree-reset/plan.md`
- Human decision, submitted 2026-08-20: create the phased implementation plan and schedule its dependency-linked task.
- Investigation report: `docs/reports/stale-worktree-session-close/report.html`

The fixed outcome is that an ordinary scheduled task freezes a fresh remote-default base before provisioning, and no native pool slot can be leased or returned as available unless it is clean, exact, and detached. Explicit pinned bases stay exact.

## Repository findings incorporated

1. `TaskDispatcher.dispatch` resolves an optional explicit primary-repository pin before `provisionAll`, but unpinned repositories reach `provisionWorktree()` with `null` and use the main checkout's current local `HEAD`.
2. `provisionWorktree()` is a lower-level exported helper used directly by tests and non-dispatch paths. It should retain its local-HEAD default. The new remote-default policy belongs in `TaskDispatcher`, which passes a frozen full SHA to the helper.
3. Attached repositories are provisioned inside `provisionAll()` and currently resolve their own local `HEAD` one at a time. Their bases must be resolved before the first lease so a later fetch failure cannot strand an earlier lease.
4. `NativeWorktreeGit.add` creates detached slots, while `NativeWorktreeGit.reset` hard-resets and cleans without detaching.
5. `WorktreeInspection` has no detached field. Manager verification therefore cannot enforce the documented detached invariant on acquisition or Return.
6. The shared `resetWorktreeToCommit()` helper also restores ensemble snapshots into selected sessions. Detachment is a native-pool policy and must not be added to that shared helper.
7. The registry's feature-branch-to-feature-branch transition rule is a real ownership safety boundary. This work prevents stale initial branch state and does not weaken that rule.
8. `git fetch origin` updates remote-tracking branch tips but not a stale local `origin/HEAD` symref. Dispatch and native Return must query or refresh the server's current HEAD after fetching before they resolve the target SHA.

## Sizing and phase count

Estimated production change: 90 to 150 materially changed or added non-test lines.

Assumptions behind the estimate:

- 45 to 80 lines for dispatch-time origin detection, current remote-HEAD proof, fetch/default resolution, frozen SHA verification, and all-repository pre-resolution.
- 20 to 35 lines for native detached inspection and reset.
- 10 to 20 lines for acquisition and Return verification changes.
- Small type and call-site adjustments, with no schema, route, shared wire contract, or UI work.

The estimate is below 200 lines, and the behavior is one lifecycle invariant. Per the phase-sizing rule, this plan has exactly one implementation phase and one one-shot task. Splitting base resolution from detachment would create an unsafe intermediate state and duplicate the same integration tests across pull requests.

## Phase table

| Phase | Outcome | Direct prerequisites | Task shape |
| --- | --- | --- | --- |
| [Phase 1: Freeze the base and prove a detached lease](phase-1-freeze-base-and-detach.md) | Scheduled tasks launch from the intended frozen base, and native slots cannot cross task boundaries with a branch attached. | This planning session and its plan-publication PR | One-shot implementation task |

## Dependency graph and merge order

```text
Planning session and plan PR
            |
            v
Phase 1 implementation task and PR
            |
            v
       Feature complete
```

There is one phase, so there are no concurrency groups or inter-phase merge choices. The implementation task remains backlogged until the planning PR merges and publishes all paths named in its prompt.

## Cross-phase contracts

Although there is only one phase, these boundaries are explicit for review and future extension:

- `TaskDispatcher` owns ordinary scheduled-task base policy.
- `provisionWorktree()` consumes an exact base when supplied and retains its direct-call local-HEAD compatibility when none is supplied.
- `WorktreeManager` owns lease state transitions and fail-closed quarantine.
- `NativeWorktreeGit` owns destructive pool reset and detached-state observation.
- `resetWorktreeToCommit()` keeps its snapshot-restoration semantics and does not gain a detach side effect.
- Registry branch ownership rotation remains unchanged.
- Ignored files remain warm; nonignored untracked files are removed.

## Final verification strategy

Phase 1 owns behavior, tests, and documentation together. Its pull request must demonstrate:

- task-dispatch base selection for fresh remote default, configured-origin failure, no-origin fallback, explicit pin precedence, and attached repositories;
- fail-closed handling when the bounded origin-existence probe itself fails or has an unknown outcome;
- a server-side default-branch switch that leaves local `origin/HEAD` stale, plus fail-closed current-HEAD query handling for dispatch and Return;
- branch-attached warm-slot reset that preserves the old branch ref while leasing detached at the requested SHA;
- exact, clean, detached verification on acquisition and Return, including quarantine on failure;
- the first real agent branch is adopted by the existing work episode rather than cancelling the task;
- focused tests, full typecheck and lint, full unit suite, build, and smoke pass.

No Playwright run is required unless the implementation unexpectedly changes a visible UI surface.

## Final compatibility audit

- Every approved source-plan behavior is owned by Phase 1.
- The submitted scheduling decision is incorporated and has no unresolved alternative.
- The low-level provisioner compatibility found during phasing is recorded in both the source plan and Phase 1.
- Inspector feedback was incorporated by making origin absence provable only through a successful remote listing; probe failure cannot select local HEAD.
- Inspector round 2 was incorporated by requiring current remote-HEAD proof after fetch instead of trusting the checkout's cached `origin/HEAD`.
- No concurrent phase can conflict because there is one phase.
- No later cleanup phase is required to make the repository operable.
- The phase does not depend on a schema migration, generated output, another repository, or an unpublished API.
