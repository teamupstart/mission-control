# Phase 4: Check executor wiring

Source plan: `docs/plans/builtin-workflows/phase-2-check-node.md` (lines 254-269, 320-323,
337-345, 380-386)
Index: `docs/plans/check-execution-runtime/phased-plan.md`

## Outcome and value

The gate stops lying. A configured, authorised `test` or `typecheck` command actually runs
against the captured commit, and a non-zero exit fails the submission and returns the failing
output to the session as a repair packet.

Today `CheckRunDeps.execute` is null in production, `runCheck` returns `unavailable`
(`checks.ts:275`), and `checkOutcomePasses` is `status !== "failed"`
(`shared/workflow.ts:831`) - so an operator who configures a test command and turns checks on
gets a green gate that ran nothing. This phase is the one that closes that, and it is small
only because Phases 2 and 3 did the hard parts.

## Entry criteria and dependencies

- **Direct prerequisites: Phase 2 and Phase 3 merged.**
- **Recommended, not required: Phase 1 merged first.** Making checks able to fail exercises
  the repair loop hard; landing this into a loop with the four known dead ends would produce
  stalled runs that read as check bugs. Phase 4 consumes nothing Phase 1 produces, so the two
  can merge in either order without breaking.

## Scope

In scope:

- The `CheckExecutor` implementation, composing Phase 2's lease with Phase 3's supervisor.
- `WorkflowManagerOptions.checkDeps` - the passthrough that does not exist.
- Injection in `src/server/index.ts`.
- `WorkflowEngine.stop()` cancelling live check groups before awaiting in-flight attempts.
- Cleanup-before-retry ordering against `handleInfrastructureFailure`.
- README, and the pool-capacity consequence.
- Extending Phase 1's repair-cycle test so a real failing check is the trigger.

Explicit non-goals:

- **`checksEnabled` stays `false` by default.** Operator decision 4 kept consent required, and
  executing branch-authored code with the daemon's filesystem authority is a larger grant than
  typing into a pane. Both switches - `checksEnabled` and the repository allowlist - stay
  deliberate. The README says how to turn it on and what it authorises.
- **No new check slots.** `WORKFLOW_CHECK_SLOTS` is append-only and already
  `["test", "lint", "typecheck", "build"]` (`shared/workflow.ts:253`).
- **No built-in workflow change.** V3's pipeline already wires `nmr-check-typecheck` and
  `nmr-check-test` (`builtin-workflows.ts:316-341`). They start working; the graph does not
  move, and versions stay immutable.
- **No Pipeline editor support.** `stageExpressible` still returns false for a graph with a
  check. That was `phase-2-check-node.md`'s non-goal and belongs to
  `phase-3-pipeline-checks-and-v2.md` in the parent plan.
- **No presentation work.** The first check unit already shipped `WorkflowNode`,
  `WorkflowLibrary` and `run-model.ts`'s four status sentences, and PR #322 has since revised
  the settings panel's check-command row onto the shared `RepoCombobox`
  (`WorkflowSettingsPanel.tsx:128-146`, `:317-328`, `:724-736`) - check *configuration*, not
  check *outcome* rendering, so this non-goal survives. This phase
  verifies they read correctly now that `passed` and `failed` actually occur, and changes them
  only if they do not.
- **No sandbox.** Still.

## Repository findings this phase depends on

- **The passthrough genuinely does not exist.** `WorkflowManagerOptions`
  (`manager.ts:180-221`) has `checkScheduler` (`:199`, forwarded at `:340`) and **no**
  `checkDeps`. `WorkflowEngineOptions.checkDeps` exists (`engine.ts:77`) and defaults to `{}`
  (`:193`). `src/server/index.ts:102-109` constructs the manager with no `engine` option.
  Three edits, one line each, and the gate goes live.
- **`runCheck` already takes the deps** (`checks.ts:231`) and the engine already passes them
  (`engine.ts:718`). Nothing in the ladder changes.
- **The scheduler split already shipped.** `pump()` resolves node kind and picks the check
  limiter or the review scheduler before acquiring either (`engine.ts:503`);
  `DEFAULT_CHECK_CONCURRENCY = 2` (`checks.ts:124`), `createCheckScheduler` (`:129`).
- **`checkVerdict` already synthesises the verdict** (`engine.ts:133-157`), including
  `evidence: [{ kind: "check", quote }]` against the shipped `EVIDENCE_REF_KINDS`
  (`shared/workflow.ts:1264-1272`). No verdict work here.
- **`WorkflowEngine.stop()` cancels nothing** (`engine.ts:204-209`): it sets `stopped`, clears
  the wake timer, and awaits `inFlight`. A live check would hold shutdown for its full timeout.
  `manager.stop()` (`manager.ts:425-436`) is called from `src/server/index.ts:282`, before the
  pool reaper stops at `:286`.
- **`handleInfrastructureFailure`** (`engine.ts:777-833`) finishes the old attempt and creates
  a fresh retry, `MAX_INFRA_ATTEMPTS = 3`, backoff `retryBaseMs * 4^(n-1)`. The source plan's
  rule (`:266-269`, `:274-279`): a lease-return failure must **not** reach it until the
  resource is clean, or a retry acquires a second lease while the first is still held.
- **`workingSubpath` is relative** (`checks.ts:54-67`), to be joined onto the leased tree -
  never onto `sessionRepoRoot`, which names the shared main repository behind a linked
  worktree.
- **Pool capacity is shared.** `treehouse.toml` sets `max_trees = 16` for this repository.
  Two concurrent checks consume two slots that dispatched sessions also want.

## Implementation steps, in execution order

### 1. The executor

New module - suggested `src/server/workflows/check-runtime.ts`. It implements
`CheckExecutor` (Contract E) and is the only place Phases 2 and 3 meet.

```
async execute(request):
  1. platform preflight (Phase 3)      -> unavailable, with a sentence
  2. request.headSha is null            -> infrastructure: nothing to pin to
  3. verifyPinnedBase(repoRoot, headSha)-> infrastructure on refusal
  4. acquireForAttempt(...)             -> infrastructure on lease/pin failure
  5. run the supervisor in <leasePath>/<workingSubpath>
  6. teardown, prove group emptiness
  7. releaseForAttempt(...) - only on `empty`
  8. map the adapter's result straight through
```

Rules, each with the failure it prevents:

- **`headSha` null is infrastructure, not `unavailable`.** A capture with no commit cannot be
  pinned, and running against whatever the tree happens to hold is the exact wrong answer this
  whole unit exists to avoid.
- **Cleanup precedes classification.** Steps 6-7 complete before returning an
  `infrastructure` result, so `handleInfrastructureFailure`'s retry cannot acquire a second
  lease behind the first. Where emptiness is `unknown`, Phase 2 keeps the row and the pin -
  the executor still returns `infrastructure`, but the retry will fail to lease and block,
  which is the correct visible outcome rather than a silent double-hold.
- **Attempt id is the lease key.** It is what `CheckProcessRegistry` and
  `workflow_check_leases` are keyed by, and what makes the holder token unique.
- The executor never decides pass or fail. `runCheck`'s ladder and `checkVerdict` own that,
  unchanged.

### 2. The passthrough

- `WorkflowManagerOptions`: add `checkDeps?: CheckRunDeps` beside `checkScheduler`
  (`manager.ts:199`).
- Forward it where `checkScheduler` is forwarded (`manager.ts:340`).
- `src/server/index.ts:102-109`: construct the executor and pass
  `checkDeps: { execute: … }`.

Wire it **after** Phase 2's lease reconciliation and therefore also above
`startPoolReaper(registry)` at `:203`. A check cannot start before the daemon knows which
trees it already holds.

### 3. `WorkflowEngine.stop()`

Cancel live check groups before awaiting `inFlight` (`engine.ts:204-209`), per the source plan
(`:320-321`). Today's `await Promise.allSettled([...this.inFlight])` would otherwise wait out
a three-minute test suite on every daemon restart.

Order in `shutdown()` matters and already reads correctly: `workflows.stop()` at
`src/server/index.ts:282` precedes `stopPoolReaper()` at `:286`, so the reaper is still alive
while leases are being returned. Do not reorder; add a comment so nobody does.

### 4. Verify the presentation reads correctly

`passed` and `failed` now occur where only `skipped` and `unavailable` could before. Check
`run-model.ts`'s four sentences against real outcomes and confirm exit code and bounded output
render in run detail. Change only what reads wrong.

### 5. README

- Extend the check-repositories section PR #322 already added rather than writing a new one.
  The check node now executes: which platforms, what consent is required, that both
  `checksEnabled` **and** the repository allowlist are asked, and that this grants
  branch-authored code the daemon's filesystem authority and is not a sandbox.
- The pooled lease: pinned to the captured commit, warm dependencies preserved because
  `resetWorktreeToCommit` uses `clean -fd` and never `-fdx`.
- **Pool capacity.** Check concurrency is 2 and each running check holds a pool slot that
  dispatched sessions also draw from. A repository whose `max_trees` is small will see
  dispatch waiting on checks. Say the number and where to change it.
- Update `docs/plans/builtin-workflows/phase-2-check-node.md` to point at
  `docs/plans/check-execution-runtime/` and record that its runtime unit shipped here. Its
  "Split recorded" note (`:44-50`) currently describes an executor that is "deliberately null",
  which stops being true at this merge.

## Data, API and compatibility

- **No schema change.** Phase 2 added the only table.
- **No wire change.** `CheckOutcome` already reaches `output_json` and the SSE run payload.
- **Behaviour change on upgrade, and it is the point:** an operator who already turned
  `checksEnabled` on and configured commands has been getting `unavailable`-and-pass. After
  this merge those commands run and can fail. That is the fix, but it will read as a
  regression to anyone who tuned their expectations to the silent pass. Call it out in the
  README and in the PR description.
- **Rollback is clean.** Reverting this phase restores the null executor and the tested
  `unavailable` path; Phases 2 and 3 remain inert and harmless.

## Tests and verification

`test/workflow-check-runtime.test.ts`:

- End to end against a real repository fixture: a failing command produces `failed` with its
  output; a passing one produces `passed`; the lease is returned in both cases.
- The command runs in the **leased** tree, not `sessionRepoRoot` - assert by making the two
  differ and having the command report its own cwd. This is the single most important
  assertion in the phase.
- `workingSubpath` is honoured for a nested entry.
- A null `headSha` is infrastructure and acquires no lease.
- A lease failure is infrastructure and never a `failed` verdict.
- Cleanup completes before an infrastructure result is returned - assert the lease row is gone
  (or deliberately retained on `unknown`) at the moment the result surfaces.

Extend `test/workflow-engine.test.ts`: `stop()` with a live check terminates its group promptly
rather than awaiting the command timeout.

Extend Phase 1's `test/workflow-repair-cycle.test.ts`: same cycle, triggered by a **failing
check** instead of a persona verdict. Do not fork it - the point is that the loop is shared.

Suite-level: the lease-leak assertion Phase 2 added must still hold with the executor live.

Commands: `npm run typecheck`, `npm test`, `npm run build`, bundle smoke.

Manual, required - the phased-plan verification step 3 and 4:

1. On a real allowlisted repository, configure a `typecheck` command that fails, dispatch a
   task, and confirm the check fails the submission, the packet reaches the session with the
   failing output, the session fixes it, and round 2 runs the check again and passes.
2. Kill the daemon mid-check. On restart confirm the lease row survived, the group was
   reconciled by identity, the tree was returned only once emptiness was confirmed, and the
   pool reaper never touched it.

## Merge and exit criteria

- CI green on Node 24 and 26.
- A configured, authorised check that fails **fails the submission**. Verified end to end, not
  by inspection - this is the defect the whole unit exists to close.
- The command demonstrably runs in the leased tree.
- Daemon shutdown with a live check completes promptly and leaves no orphan and no leaked
  lease.
- README documents execution, consent, platforms, the non-sandbox, and pool capacity.
- `phase-2-check-node.md`'s "deliberately null" note is corrected.

## Downstream handoff

The parent plan's `phase-3-pipeline-checks-and-v2.md` may now assume checks execute, which is
what makes a built-in version carrying them worth shipping.

Future work this deliberately leaves open, each already named as a follow-up: a real execution
sandbox (`phase-2-check-node.md:325-330`); a trusted per-repository command file read from the
default branch (`:232-244`); and `lint` / `build` slots in a built-in graph.

Nobody may: run a check outside a pinned lease; use `sessionRepoRoot` or `sessionCwd` as the
execution directory; make a lease or pin failure a `failed` verdict; or return a lease before
group emptiness is confirmed.

## Cross-phase audit record

- **2026-07-30, at authoring:** re-read the source plan, the index, and Phases 1-3. Consumes
  Contract E unchanged, Phase 2's lease API, and Phase 3's tri-state emptiness. Adds no
  interface of its own.
- **Shared file with Phase 1:** `workflows/manager.ts`. Regions disjoint - this phase owns
  `WorkflowManagerOptions` (`:180-221`) and engine forwarding (`:332-348`); Phase 1 owns
  `unchanged_evidence` (`:3171-3186`) and `claimCompletion` (`:1632-1737`, widened by #323). Recorded in the
  index. Whichever merges second rebases and keeps both.
- **Checked that no earlier phase needs editing.** Phase 2's `releaseForAttempt` already
  refuses without positive identity, which is what step 1's cleanup-before-classification rule
  relies on; Phase 3's tri-state is already the authorisation signal. Neither contract had to
  widen to serve this phase, which is the evidence the boundaries were drawn in the right
  place.
- **Confirmed the ordering constraint is transitive:** Phase 2 requires lease reconciliation
  before `startPoolReaper`; this phase's injection must sit after that reconciliation and
  therefore also above `:203`. Stated in step 2 so it is not rediscovered.
