# Phase 2: Guarded automatic reclamation

## Outcome

Mission Control automatically reclaims every worktree still owned by a `done`, `failed`, or
`cancelled` task once Phase 1's aggregate Git-visible activity boundary has remained unchanged for
30 days. Cleanup discards staged, unstaged, untracked, committed, and unpushed work at expiry, but a
change in any attached repository before the destructive boundary grants a fresh 30 days.

The dashboard keeps the existing manual **Clean up** action during the grace period, removes it
through the existing task update after success, and shows a bounded automatic-cleanup retry
explanation when provider, occupancy, archive, or ownership uncertainty leaves a due resource
standing.

## Entry criteria and dependencies

- Direct dependency: Phase 1, `phase-1-durable-activity-observation.md`, is merged.
- The planning pull request is merged and Phase 1's table, store, activity probe, observer lifecycle,
  resource generation, and all-repository predicate are the implementation source of truth.
- Governing references are the [source plan](./plan.md), [phased index](./phased-plan.md),
  [Phase 1 handoff](./phase-1-durable-activity-observation.md),
  [architecture guide](../../agent-guides/architecture.md),
  [change contracts](../../agent-guides/change-contracts.md),
  [worktree operations](../../worktrees-and-checks.md),
  [task lifecycle](../../dispatch-and-backlog.md),
  [shipping behavior](../../inspector-and-shipping.md),
  [configuration](../../configuration.md), and [E2E guidance](../../../e2e/README.md).

## Scope

- Turn the Phase 1 observer into the owner of due cleanup claims and retry transitions.
- Add an automatic reclaim entry through `TaskManager` that shares the existing reclaim core and
  performs final task/fingerprint validation immediately before teardown.
- Serialize background cleanup by physical repository and close overlaps with manual reclaim,
  reschedule, remove, cancel, startup reconciliation, and another retention pass.
- Replace restart's immediate teardown for a proven-gone task agent with terminal settlement that
  preserves every worktree/provider/lease fact for the same 30-day policy.
- Preserve due age across automatic partial release and retry the remaining resource facts with
  bounded exponential backoff.
- Project only a bounded, browser-safe retry summary onto `Task` and update the Recent outcomes UI.
- Apply the shared all-repository ownership predicate to remaining lifecycle and UI consumers.
- Update product documentation and add required unit, integration, render, runtime, and Playwright
  coverage.

## Non-goals

- Do not create a second worktree release path or directly call provider release from retention.
- Do not change `session_remove` semantics or infer durable exit from `state === "exited"`.
- Do not apply this policy to manual development worktrees, Workflow check leases, ensemble
  snapshots, or arbitrary Git worktrees.
- Do not add per-task, per-repository, or global duration controls, and do not add an off switch.
- Do not push work, create rescue refs, make patches, or check remote merge/push state before cleanup.
- Do not replace task outcome or task failure text with maintenance errors.

## Repository findings and inherited contracts

- `TaskManager.reclaim()` already quiesces the launched agent, settles scout archives, tears down
  every task repository through its recorded provider, preserves partial failures, clears released
  facts, and emits the task update the dashboard consumes. Automatic cleanup must share this core.
- The current public reclaim method has asynchronous gaps before `teardownWorktree()`. A due sweep
  that validates only before entering it can race a reschedule, path replacement, manual cleanup,
  or a last local edit. `TaskManager` needs two guards with different inputs: validate the complete
  claimed generation and fingerprint before quiescence/archive work, then compare the stable
  task-attempt/worktree-ownership snapshot plus a fresh fingerprint immediately before teardown.
  The second guard must not compare terminal/session fields that the reserved cleanup itself may
  have changed.
- `StartupCleanupQueue` in `src/server/tasks.ts` already serializes jobs that touch the same canonical
  repositories while allowing disjoint repositories to progress. Reuse or extract it; do not add an
  unrelated queue with different key semantics.
- `reconcileOnStartup()` currently tears down after a confident `homeAlive() === false`. This bypasses
  retention and must be replaced only after the task has been re-read and the launch generation
  proven unchanged.
- `releasedTaskResources()` and `reclaimedFrom(error)` already preserve exact remaining primary and
  attached facts after partial teardown. The retention service must adopt that resulting generation
  under its active claim instead of treating its own partial cleanup as new user activity.
- `ReportPanel` currently gates Retry and **Clean up** on the primary `worktreePath`. An attached-only
  survivor must still offer cleanup and must not offer Retry as if it were resource-free.
- Whole `Task` values already ride `task_upsert` and initial snapshots. A small derived summary can
  use that path without browser polling or a new `ServerEvent`, but internal fingerprints, claims,
  and raw errors stay server-only.
- `e2e/specs/native-worktree-dispatch.spec.ts` already proves real multi-repository native dispatch,
  a failed retained task, manual cleanup, and slot reuse with fake agents. Reuse its setup or add a
  focused sibling rather than inventing a second fake-provider path.

## Implementation steps

### 1. Define due, claim, retry, and crash recovery transitions

Extend the Phase 1 store with explicit compare-and-swap operations over the expected task ID,
resource generation, fingerprint, cleanup state, and due/retry boundary.

The state machine must support:

1. `observing` until `cleanup_due_at <= now`;
2. an atomic claim carrying a unique token and `claimed_at`/attempt time;
3. successful completion, which deletes the row after the task no longer holds a worktree;
4. changed activity or external generation, which clears the claim and starts a full new grace
   period from the fresh successful observation;
5. unknown final observation or cleanup refusal, which keeps the last valid activity boundary and
   enters retry with bounded error and `retry_at`;
6. partial automatic release, which adopts the exact generation and fingerprint of the resources
   still standing while preserving the already-due activity boundary;
7. an abandoned claim after daemon death, which becomes retryable on startup without a duplicate
   concurrent cleanup; and
8. proven-dead restart settlement, which adopts the exact post-settlement generation while
   preserving a matching row's fingerprint, activity boundary, and deadline.

A reserved cleanup can legitimately stop or clear terminal/session ownership before an archive or
provider refusal leaves the worktree standing. Treat that like cleanup-caused partial release:
adopt the post-attempt generation under the same claim and preserve the due boundary when the stable
attempt/worktree ownership and fingerprint did not change. It is not new user activity.

Use exponential retry backoff capped at one day, plus enough deterministic injection to test it.
The recurring observer remains the one scheduler. A changed fingerprint has priority over an old
retry: changed work gets a new 30-day period, not an immediate retry inherited from prior state.

Never claim a row unless a fresh successful probe still matches its fingerprint. The regular
cadence may establish that fact, but a due row must probe again before claim or as part of the claim
workflow. An `unknown` result is not inactivity.

### 2. Add a guarded automatic reclaim entry through TaskManager

Refactor `TaskManager.reclaim()` only enough to share one private reclaim core between the existing
manual route and an internal automatic call. Preserve the public route response and manual
confirmation behavior.

The automatic call must accept or close over:

- the claimed task ID, generation, and fingerprint;
- a pre-mutation validation callback plus a final validation callback backed by Phase 1's aggregate
  probe;
- a structured result channel that distinguishes reclaimed, activity changed, ownership changed,
  unknown validation, archive refusal, provider/occupancy failure, and partial release.

Inside `TaskManager`, reserve the task for reclaim before any quiescence or archive work. Manual
reclaim, reschedule, remove, cancel, startup cleanup, and another automatic attempt must see the
reservation and either wait through the existing repository priority mechanism or return a clear
conflict without performing a second teardown.

For the automatic path, in execution order:

1. verify the task is still `done`, `failed`, or `cancelled` and still has a worktree;
2. re-read the task, run a fresh pre-mutation aggregate probe, require exact generation and
   fingerprint equality with the active ledger claim, and freeze the stable status/attempt plus
   ordered worktree path/provider/lease snapshot;
3. quiesce any launched agent and settle required archives through the existing methods;
4. re-read the task and require the stable snapshot to match, allowing only terminal/session changes
   caused by this reserved cleanup;
5. run the final aggregate probe against those exact recorded worktree paths and require its
   fingerprint to match the active claim; and
6. only then call `teardownWorktree()` through the existing provider-aware code.

Never defer the complete-generation comparison until after quiescence. The generation deliberately
contains terminal-home, terminal-resource, and session identity, so a post-quiescence-only check can
reject the cleanup's own expected mutations forever.

Release the task reservation in `finally`. Move `autoCompleted` mutation and other one-way in-memory
changes after final validation so an aborted automatic attempt does not alter task lifecycle state.
Do not weaken manual cleanup's partial-release accounting.

### 3. Share repository-aware cleanup serialization

Extract `StartupCleanupQueue` into a reusable task cleanup coordinator, or extend it in place if the
ownership remains clear. Jobs name all canonical repository keys from `taskRepoRefs()` and only one
background cleanup may touch a given key at a time. Disjoint repositories may progress concurrently.

Do not enqueue an entire stale fleet ahead of foreground work. Preserve native
`WorktreeManager.release()` foreground priority and bound the number of claimed/background jobs so a
same-repository stale set cannot form the startup convoy already covered by
`test/task-startup-cleanup.test.ts`.

A job that waited in the queue must re-read eligibility, claim identity, generation, and activity
before entering `TaskManager`. Queue position is never authorization to reclaim.

### 4. Replace restart's immediate teardown with retention

Update `needsStartupReconcile()` and related resource checks to use the Phase 1 all-repository
predicate plus terminal-home ownership where appropriate. Preserve the existing special handling
for interrupted-before-provision tasks, embedded SDK sessions, pipeline completion providers, and
unknown terminal backends.

When the unchanged launch is confidently proven gone:

- re-read and freeze the pre-settlement task attempt, worktree paths, providers, leases, terminal
  identity, session binding, and computed generation;
- settle `running` or `dispatching` to `failed` with the existing honest restart explanation;
- preserve `done` and `cancelled` status, outcome, and task error;
- clear only a session binding that the existing reconciliation contract proves gone;
- retain the terminal home/resource identity for the shared reclaim core to resolve safely; and
- retain every primary and attached worktree/provider/lease fact without calling archive settlement
  or teardown.

If the ledger has a row matching the frozen pre-settlement generation, persist the task settlement
and compare-and-swap that row to the computed post-settlement generation in one SQLite transaction.
Preserve its fingerprint, `last_changed_at`, `cleanup_due_at`, and retry age; abandoned-claim
recovery still owns any claim-state transition. If no row exists, settle normally and let the first
successful observation grant the conservative full period. If the task no longer matches, abort
and re-read without committing either write. If the task remains exact but a fresh read proves the
row belongs to another external generation, settle the task without adopting that row; ordinary
successful observation replaces it under the explicit external-generation rule. Publish the
Registry task update only after the applicable transaction commits.

The ordinary observer must recognize the adopted row as the current generation rather than an
unseen one. A retained scout report remains in the tree and is archived later by the shared reclaim
core immediately before actual teardown.

Update startup tests to prove a dead terminal home no longer frees a worktree immediately, that an
attached-only task is reconciled and observed, and that live or unknown ownership remains untouched.

### 5. Handle success, activity, and partial failure

After the TaskManager result, the retention service must re-read the task:

- On full success, confirm `taskHasWorktrees()` is false, delete the ledger row, and rely on the
  existing task upsert to remove cleanup UI and release allocator capacity.
- On a changed fingerprint, store that new fingerprint and set `last_changed_at = now` and
  `cleanup_due_at = now + 30 days`.
- On external status, attempt, path, provider, lease, home, resource, or session replacement, abandon
  the claim and let observation seed the new generation. Never apply the old due time to it.
- On terminal/session identity changed by this reserved cleanup while stable attempt/worktree
  ownership and Git state remain equal, adopt the post-attempt generation and preserve the due
  boundary for retry. Do not classify the cleanup's own mutation as an external replacement.
- On automatic partial release, use the active claim token to adopt only the still-recorded resource
  generation, preserve the due boundary, store the current aggregate fingerprint for remaining
  worktrees, and enter bounded retry.
- On unknown or provider/occupancy/archive failure, keep every remaining fact and the last valid
  activity boundary, store a bounded safe error, and schedule retry.

If no worktree remains but a terminal-home cleanup failed, automatic worktree retention is complete;
do not keep a worktree ledger alive solely for a home. The existing task cleanup path may continue
to expose any independently reclaimable resource according to its own contract.

### 6. Project a browser-safe retry summary

Add a nullable shared type on `Task` for the minimum automatic-cleanup state the dashboard needs.
Prefer a shape that is null during ordinary observation and contains only a stable retry state,
bounded human-safe explanation, and retry time after a due cleanup fails. Do not expose the
fingerprint, generation, claim token, raw Git output, internal paths beyond existing Task fields, or
an unbounded provider exception.

Project the summary from the ledger in the batched DB task loader. Add a focused Registry method
that refreshes the derived summary and emits the ordinary whole-task `task_upsert` without writing
a second copy into `tasks`. Ensure later task upserts preserve or re-derive the current summary and
restart produces the same Task shape.

Update all Task constructors, schemas, fixtures, and exhaustive browser consumers required by the
wire change. Do not introduce a new `ServerEvent` or browser polling.

### 7. Update task behavior and copy

In `src/web/components/ReportPanel.tsx`:

- use the shared all-repository predicate for **Clean up** visibility;
- offer Retry only when no primary or attached worktree remains;
- keep the existing two-click manual cleanup during the grace period;
- explain in the cleanup tooltip or adjacent concise copy that inactive worktrees are automatically
  removed after 30 days; and
- render the bounded automatic-cleanup retry explanation separately from `outcome` and `error`.

Update related lifecycle wording in `ShippingSettingsPanel.tsx` and `KillModal.tsx` where it promises
that a kept checkout remains until explicit cleanup. Keep copy direct about destructive local-work
removal and do not imply push or merge state is checked.

Add render-to-static-markup coverage for attached-only cleanup visibility, Retry exclusion, policy
copy, and maintenance error separation. Select browser elements by role, label, or visible text;
never add `data-testid`.

### 8. Update documentation

Update:

- `docs/dispatch-and-backlog.md` for completion, durable session removal, restart, manual cleanup,
  and automatic cleanup state transitions;
- `docs/worktrees-and-checks.md` for the fixed 30-day task-worktree policy, Git-visible activity,
  multi-repository aggregation, provider-aware teardown, partial failure, and policy boundaries;
- `docs/inspector-and-shipping.md` to replace the current indefinite dirty/untracked preservation
  promise; and
- `docs/configuration.md` to state that `MISSION_WORKTREE_SWEEP_MS=0` disables native allocator
  reconciliation only, not terminal task retention, and that the 30-day duration has no initial
  configuration key.

Do not edit archived backups, generated documentation, or `CHANGELOG.md`.

## Data, API, migration, and compatibility details

- Reuse Phase 1's table. Phase 2 should need no migration unless implementation evidence proves a
  missing invariant; if it does, add an additive migration beside the upgrade path and record the
  deviation in the pull request and this phase audit.
- Automatic claim writes use SQLite compare-and-swap conditions, not an in-memory flag alone.
  TaskManager's reservation closes in-process lifecycle overlap; the ledger closes timer/restart
  overlap. Both are required.
- Restart settlement and matching generation adoption share one SQLite transaction. A crash cannot
  expose a settled task with the old matching generation and cause the next observation to move a
  valid deadline. An absent row remains eligible for ordinary first-observation seeding.
- A crash during provider teardown is uncertain. On restart, reconcile actual task/provider facts
  first, then retry the abandoned claim. Do not assume the prior command had no effect.
- Existing Task JSON gains only the nullable safe summary. Old persisted tasks derive null when no
  ledger retry exists. No client may require the field to be non-null.
- `POST /api/tasks/:id/reclaim` remains the manual API and preserves its response contract. The
  automatic entry remains an internal daemon call, not a new public route.
- A changed worktree at day 29 gets a new full deadline. Cleanup runs on the first successful sweep
  at or after a deadline, so actual wall time may exceed 30 days by at most the normal sweep delay
  plus a bounded retry.
- Push, upstream, pull request, and merge status are deliberately absent from eligibility.

## Tests and verification

### Focused server tests

Extend Phase 1 tests and existing task/provider suites to cover:

- exact due-boundary eligibility for `done`, `failed`, and `cancelled` tasks;
- exclusion of `backlog`, `dispatching`, and `running` tasks;
- a day-29 fingerprint change and a full new 30-day window;
- fresh successful validation immediately before teardown;
- activity, generation, status, path, provider, lease, home, resource, or session change during the
  reclaim gaps aborting without teardown;
- quiescence changing terminal/session identity without causing the attempt to self-abort, while a
  genuinely external replacement still aborts;
- simultaneous automatic passes and manual reclaim producing one teardown;
- reschedule/remove overlap refusing stale automatic authority;
- daemon death with an active claim and safe retry after reopen;
- provider refusal and unknown process occupancy preserving resource facts;
- partial primary or attached release adopting the remaining generation without a new 30-day grace;
- native, disposable Git, and exact legacy Treehouse dispatch through recorded provider ownership;
- same-repository cleanup serialization with disjoint progress and no unbounded foreground convoy;
- restart settlement retaining a dead agent's primary and attached trees;
- a restart that clears a proven-dead session binding adopting the post-settlement generation without
  moving an existing `last_changed_at` or `cleanup_due_at`, including reopen after the transaction;
- a settlement task/ledger compare-and-swap mismatch aborting without a half-applied task update; and
- manual cleanup continuing to work before expiry.

Use or extend `test/task-startup-cleanup.test.ts`, provider cleanup tests, task route tests, Phase 1
retention tests, and task render tests rather than duplicating their fixtures.

### Browser end-to-end proof

Add a focused spec beside `e2e/specs/native-worktree-dispatch.spec.ts`, or extend that spec if setup
reuse keeps it clearer:

1. dispatch a fake-agent task through a real native worktree and let the agent exit without a
   recorded outcome;
2. wait for the durable observation row, stop the daemon, create a local unpushed commit in the
   worktree, and age the prior ledger deadline while SQLite is closed;
3. restart and prove the changed fingerprint postpones cleanup and the **Clean up** action remains;
4. stop again, age the newly persisted unchanged boundary beyond 30 days, restart, and observe the
   existing task event remove the cleanup action without manual confirmation; and
5. dispatch another task that proves the native slot is reusable.

The spec may manipulate the retention ledger only while the test daemon is stopped. That is a
fixture technique, not a production duration or disable setting. Phase 1 unit tests carry the
exhaustive staged, unstaged, untracked, ignored, and multi-repository fingerprint matrix. The E2E
case proves that changed unpushed work resets the boundary and is later discarded when unchanged.
All agent binaries remain faked.

### Commands

Run focused tests with the mandatory preload, then all required UI/runtime gates:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/task-worktree-retention-observer.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-startup-cleanup.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-triage-render.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

## Merge and exit criteria

- Every eligible task is reclaimed only after one aggregate fingerprint remains unchanged for the
  full persisted 30-day period and a fresh final validation matches.
- Staged, unstaged, untracked, local-commit, and unpushed state resets but never permanently exempts
  a tree.
- Restart cannot immediately reclaim a task tree, reset a valid existing clock when it clears a
  proven-dead session binding, or duplicate an abandoned cleanup.
- Unknown ownership, Git, process, archive, or provider state preserves durable facts and retries.
- Partial cleanup clears only released resources and retries the remainder without granting the
  cleanup operation itself a new grace period.
- Manual cleanup and reschedule remain functional and cannot overlap destructive work.
- Attached-only survivors remain loaded, visible, manually reclaimable, and automatically eligible.
- UI copy states the policy, success removes the affordance through SSE, and retry diagnostics do not
  replace task outcome/failure text.
- Documentation matches the implemented lifecycle and configuration boundary.
- Focused tests, typecheck, lint, full unit suite, build, smoke, and Playwright pass.
- The pull request explains any repository-driven deviation from this proposed route.

## Downstream handoff

This is the final implementation phase. Later work may add observability or a separately approved
configuration surface, but must continue to use the task retention ledger, activity probe,
TaskManager reclaim core, durable `session_remove`, recorded provider authority, and shared
all-repository predicate.

No later cleanup is expected to complete this feature. The merged phase is responsible for schema,
server lifecycle, destructive safety, UI behavior, documentation, and browser proof together.

## Cross-phase audit record

- Initial audit: this phase consumes every Phase 1 contract named in its downstream handoff and
  introduces no alternate clock, Git parser, timer, repository list, or provider release path.
- Restart audit: the existing immediate teardown discrepancy is resolved here, where durable due
  cleanup is available, rather than in observation-only Phase 1.
- Partial-failure audit: the active claim distinguishes cleanup-caused generation shrinkage from an
  external replacement, so retry age and replacement safety do not conflict.
- Inspector audit on 2026-08-20: generation validation moved before quiescence/archive work, with a
  separate stable ownership and fingerprint guard immediately before teardown. This prevents the
  reclaim path from rejecting terminal/session mutations it caused itself.
- UI audit: the nullable summary is derived from the ledger, rides existing whole-task events, and
  excludes internal hashes and raw errors.
- Final audit: all source-plan requirements not delivered by Phase 1 are assigned to this phase,
  including documentation and mandatory Playwright coverage.
- Final reconciliation on 2026-08-20: the phase links to and consumes Phase 1's exact store, probe,
  lifecycle, generation, and predicate contracts. The serial dependency remains necessary and no
  undocumented post-phase cleanup remains.
- Inspector documentation-safety audit on 2026-08-20: entry criteria now state neutral governing
  references and contain no reader-directed file-opening instruction.
- Inspector restart audit on 2026-08-20: the settled task and matching ledger generation now move in
  one transaction, preserving the prior fingerprint and deadline instead of triggering a second
  first-observation grace period.
