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
- Injection in `src/server/index.ts`, for both the executor and Phase 2's group-recovery seam.
- `WorkflowEngine.stop()` cancelling live check groups before awaiting in-flight attempts.
- Cleanup-before-retry ordering against `handleInfrastructureFailure`, including the
  unresolved-lease retry gate.
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
  a **fresh** retry, `MAX_INFRA_ATTEMPTS = 3`, backoff `retryBaseMs * 4^(n-1)`. The source
  plan's rule (`:266-269`, `:274-279`): a lease-return failure must **not** reach it until the
  resource is clean, or a retry acquires a second lease while the first is still held. Note
  the retry is a **new attempt id**, so it gets a new holder token and can lease a *different*
  pool tree - there is no natural collision that would stop it. The gate has to be explicit.
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
  lease behind the first.
- **An `unknown` emptiness must BLOCK, not retry**, and this needs a guard in the engine
  rather than a rule in the executor. `handleInfrastructureFailure` finishes the old attempt
  and creates a **fresh** one, and a lease is keyed by attempt id - so the retry carries a new
  id, therefore a new holder token, and `acquireForAttempt` will cheerfully lease a *different*
  pool tree while the original group may still be writing into the first. Add the guard where
  the retry is created: before `handleInfrastructureFailure` produces a new runnable attempt
  for a check node, ask Phase 2's `unresolvedLeaseForNode(submissionId, nodeId)`. If a lease is
  still `held` or `returning`, set the run `blocked` with a distinct phase (suggested
  `check_cleanup_unresolved`) instead of retrying, and let Phase 2's reclamation pass resolve
  the lease. Contract E stays untouched - the executor still returns the published
  three-variant result, and the retry decision stays where retry decisions already live.
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
- **Inject Phase 3's `CheckGroupRecovery` into Phase 2's `reconcileOnStartup` seam.** Phase 2
  declared it with a refusing default (`async () => "unknown"`) because Phase 3 merges after it,
  so until this line exists a daemon restart keeps every non-sentinel lease held rather than
  returned. That is the fail-closed direction and it is not a leak - the reclamation pass still
  runs - but it means the seam is dead until wired here. Leaving it unwired is the one way this
  phase can look finished and quietly retain a pool slot per restart.

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
- **Startup recovery is wired.** Restart with a non-sentinel lease row whose group is gone and
  assert the tree is returned; with a group still alive, assert it is not. The refusing default
  passes the first half of that test trivially, so assert the *return* actually happens - that
  is what proves the injection exists rather than the default.
- Cleanup completes before an infrastructure result is returned - assert the lease row is gone
  (or deliberately retained on `unknown`) at the moment the result surfaces.
- **An `unknown` emptiness blocks instead of retrying.** Force the tri-state to `unknown` and
  assert no second attempt is created, no second lease is acquired, and the run is `blocked`
  with the distinct phase. Without this test the defect is invisible, because the happy path
  and the broken path both look like "the check eventually finished".

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
- An unresolved group never produces a second lease - the run blocks and says so.
- Phase 2's group-recovery seam is injected, proven by a restart test that observes a real
  return rather than the default refusal.
- README documents execution, consent, platforms, the non-sandbox, and pool capacity.
- `phase-2-check-node.md`'s "deliberately null" note is corrected.

## Downstream handoff

The parent plan's `phase-3-pipeline-checks-and-v2.md` may now assume checks execute, which is
what makes a built-in version carrying them worth shipping.

Future work this deliberately leaves open, each already named as a follow-up: a real execution
sandbox (`phase-2-check-node.md:325-330`); a trusted per-repository command file read from the
default branch (`:232-244`); and `lint` / `build` slots in a built-in graph.

Nobody may: run a check outside a pinned lease; use `sessionRepoRoot` or `sessionCwd` as the
execution directory; make a lease or pin failure a `failed` verdict; return a lease before
group emptiness is confirmed; or let a check node retry while it still holds an unresolved
lease.

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

- **2026-07-30, Inspector round 2 (PR #326):** finding accepted - *"Do not retry while group
  cleanup is unknown"*. It was correct and the plan's reasoning was wrong. This phase had
  claimed that on an `unknown` emptiness "the retry will fail to lease and block". It would
  not: `handleInfrastructureFailure` creates a fresh attempt, a lease is keyed by attempt id,
  so the retry carries a different holder token and the pool has other slots to give it. The
  retry would succeed on a second tree while the first group may still be writing. Corrected
  to an explicit gate at the point the retry is created, consuming Phase 2's new
  `unresolvedLeaseForNode`. The enabling columns were added to Phase 2 rather than looked up
  here, per the rule that a shared decision belongs to the earliest phase that must own it;
  recorded in that phase's audit too. Contract E is unchanged - the fix is in the retry
  policy, not the executor's result type.
- **2026-07-31, at implementation.** Modules shipped: `check-runtime.ts` and
  `test/workflow-check-runtime.test.ts`; `WorkflowEngine.stop()`, the retry gate, the manager
  passthrough, the `src/server/index.ts` wiring, README and this document's source plan.
  Seven deviations from this document's literal text, each with the reason.

  1. **The one defect that mattered was found by running it, not by reading it, and this
     document did not anticipate it.** Evidence capture records `git rev-parse --short HEAD`
     (`src/server/diff.ts:165`), so `WorkflowContextSnapshot.evidence.headSha` on every real
     submission is a **seven-character abbreviation** - while `verifyPinnedBase` refuses
     anything that is not a full 40-hex id, deliberately, because `requireSha` will not
     hard-reset a worktree onto a name it cannot pin exactly. Wired exactly as specified, the
     first end-to-end run produced *"pinned base "cd8ad06" is not a full 40-character commit
     id"* three times and blocked: **the gate still never ran.** Every automated test in the
     phase passed, because every one of them supplied a full sha.

     Fixed by resolving the capture's identifier through `git rev-parse --verify` before the
     lease, in `check-runtime.ts`. That direction rather than the other one: an abbreviation
     only names a commit if the repository says which one, and `--verify` refuses an ambiguous
     prefix, so this narrows to exactly one commit or fails - whereas relaxing `requireSha`
     would have let an ambiguous prefix decide which commit somebody's build ran against. A
     full id short-circuits, which is the shape `submission.prHeadSha` already arrives in.
     Regression test: *"an abbreviated captured commit still pins the worktree"*, which runs
     `git rev-parse HEAD` inside the leased tree and asserts it equals the full commit.

     Worth recording as a pattern, since this document's own instruction was not to report the
     phase done on the strength of the diff: the seam contracts were all honoured, and the two
     halves still did not fit, because each half was tested against the shape the OTHER half
     was assumed to produce.
  2. **`checkDeps` is a factory, `(attempt) => CheckRunDeps`, not a `CheckRunDeps`.** Step 2 of
     this document says to add `checkDeps?: CheckRunDeps` and pass `{ execute: … }`. That
     cannot work: a `CheckExecutor` receives a `CheckExecutionRequest`, which describes a
     COMMAND - slot, argv, repository, commit - and carries no attempt identity, while step 1's
     own rule is that the attempt id is the lease key and Contract R needs the submission and
     node ids to gate a retry. One of the two had to give. Contract E is explicitly owned by
     nobody and changed by nobody, so the identity is BOUND rather than added to the request.
     `CheckAttemptRef` is declared in `check-runtime.ts` - **this phase's own module, not
     `checks.ts`, which is left untouched** - which is the same seam direction Phase 3 took with
     `CheckSupervisorLookup`: the consumer names the narrow shape it needs and its composer
     supplies one. The alternative, widening `CheckExecutionRequest` and `runCheck`'s input,
     would have edited the one contract this phase was told not to touch and made every existing
     caller of `runCheck` supply an identity it has no reason to hold.
  3. **`unresolvedCheckLease` is its own engine option** rather than riding on `checkDeps`. It
     is consulted where a retry is created, a path the executor never reaches, and the two are
     wired together in `index.ts` from one `CheckRuntime` so neither can be injected without the
     other. Also applied in `recover()`, which this document did not name: a daemon that died
     mid-check rolls its interrupted attempt over on restart, and that is the likeliest place of
     all for a second tree to be leased behind a group that outlived us.
  4. **One added member on an earlier phase's module, authorized by the operator.**
     `CheckLeaseManager.handOffForReclaim` exists because `releaseForAttempt` drops the
     in-memory ownership claim in its `finally` *and* issues the return - so a check whose group
     could not be proven empty had no exit at all: not returning kept it in `owned`, and
     `reclaimLeaked` skips owned rows, so the lease would have been collected by nothing until a
     restart. A pool slot per unprovable group, for the life of the daemon, which is the exit
     criterion about leaked leases failing. The two alternatives were put to the operator with
     their costs - a second reclamation loop inside `check-runtime.ts` duplicating Phase 2's
     backoff and bounding over the same table, or accepting the leak - and the decision was:
     *"Don't introduce a defect. Keeping the originally planned interfaces isn't important,
     what's important is that the feature works as intended."* So the three lines stay, and the
     lease goes back to the single owner of reclamation rather than growing a parallel one.
  5. **`verifyPinnedBase` is not called separately** (step 1's item 3). `acquireForAttempt`
     already calls it as its first act, before anything is leased, which is exactly the ordering
     that item wanted; calling it twice would be a second git process per check for no answer.
  6. **The `CheckRuntime` construction moved ABOVE the `WorkflowManager`** in
     `src/server/index.ts`, not merely above `startPoolReaper`. Step 2 states the reaper
     ordering; the stronger constraint is `workflows.start()`, which recovers runs and can
     schedule a check attempt immediately - a check must not be able to lease before
     reconciliation has said which trees we already hold. The reclamation pass also gets the
     group-recovery seam, which this document mentioned only for `reconcileOnStartup`;
     uninjected there it would have kept every non-sentinel lease forever.
  7. **`WorkflowEngine.stop()` calls Phase 3's published `killLiveCheckGroups`**, not a new
     orderly plural teardown. A first draft added `terminateLiveCheckGroups` to `check-group.ts`
     so a shutdown would get the `SIGTERM`-grace-`SIGKILL` ladder; it was removed on review.
     The grace period buys a test runner the chance to flush output that, at shutdown, nobody is
     left to read - the attempt ends as an infrastructure failure either way - and the identical
     `SIGKILL` reaches those groups from the `exit` hook moments later regardless. So the
     existing export does the job with nothing added, and `stop()` still waits for its attempts
     afterwards, which is where the emptiness proof and the lease return actually happen.
     Measured on a real daemon with a 300-second command live: **0.65s** to shut down, no orphan,
     the pooled worktree back in the pool. `killLiveCheckGroups`' own comment, which named
     `WorkflowEngine.stop()` as a caller of the *other* path, was corrected so the code and the
     prose agree.
  8. **No presentation change was needed.** `run-model.ts`'s four sentences and
     `CHECK_OUTCOME_STATUSES` read correctly against real `passed` and `failed` outcomes -
     `passed`/`failed` fall through to the ordinary verdict mapping and only the two
     did-not-run statuses are marked degraded, which is right now that the other two occur. Two
     broken README anchors (`#check-nodes-gating-on-a-command`, which matches no heading) were
     fixed in passing.

- **2026-07-31, Inspector round 1 (PR #352).** One `major`, accepted, and it was a defect
  introduced by the fix for deviation 1 - the door opened to resolve an abbreviated commit was
  wider than the thing it was opened for.

  *"Restrict captured commits to SHA identifiers."* `resolveCapturedCommit` passed any
  non-40-character `headSha` straight to `git rev-parse --verify`, which resolves REVISION
  EXPRESSIONS and not just object ids. So `HEAD~1`, a branch name, a tag or `@{yesterday}` would
  all answer with a real commit - just not the one the submission captured - and the check would
  run against that tree and report the answer as if it were about this submission. That is
  exactly the wrong-verdict-rather-than-a-crash failure the working-directory containment check
  already names as the worst shape available here, arriving through a different door.

  Probing it surfaced a **second** hazard the finding did not name, and it is the one that
  survives the obvious fix: **a ref shadows an object id of the same spelling.** Measured
  directly - a branch literally named `04a6ee7` beats the commit whose id starts with `04a6ee7`,
  and git resolves to the branch's commit with only a warning on stderr. A hex-prefix regex
  alone would have passed that straight through. Reachable rather than theoretical, since branch
  names here are generated.

  Fixed with both guards: the input must be a lowercase hex object-id prefix (four characters is
  git's own floor) before git is asked at all, and the resolved id must START WITH the prefix
  that asked for it, which is the only thing that proves git handed back the object we named.
  Both refusals are infrastructure, and both refuse before the pool is asked, so an
  unidentifiable commit costs no slot. Two tests, each of which fails against the unfixed code,
  and the shadowing one asserts git's behaviour first rather than assuming it.

- **2026-07-31, Inspector round 2 (PR #352).** One `major`, **declined with measurement**, and
  the measurement is now a test rather than a claim.

  *"Reject full-SHA ref shadowing."* The premise was that a repository can hold a ref named
  exactly like a full 40-character sha but pointing elsewhere, and that git's revision parser
  might select the ref for the later pin or reset. Read against round 1's finding it looks like
  the same defect one size up, which is why it was worth measuring rather than reasoning about.

  It does not hold, and git says so itself. A full 40-hex string is interpreted as an object id
  unconditionally; a ref of that name is IGNORED, and git's own warning explains exactly this -
  *"Git normally never creates a ref that ends with 40 hex characters because it will be ignored
  when you just specify 40-hex."* Measured through the whole path with such a ref constructed
  and pointing at a different commit: `rev-parse --verify` answered with the object, the
  `reset --hard` inside a linked worktree landed on the object, and `verifyPinnedBase` returned
  the object. That asymmetry against the abbreviated case is precisely why the two lengths are
  treated differently, and it is the whole argument for short-circuiting a full id rather than
  round-tripping it.

  Two independent guards would catch it even if a future git changed its mind, and both run
  before any command does: `verifyPinnedBase` refuses unless `resolved === baseSha`, and
  `verifyHeadIs` refuses unless the worktree's HEAD equals the sha after the reset. So the
  failure mode would be a blocked run, never a verdict about the wrong tree.

  Declined on the code and accepted on the principle: the asymmetry was load-bearing and
  nothing executed it, which is the shape of an argument that quietly stops being true. It is
  now pinned by *"a ref named like a full commit id cannot shadow it"*, which constructs the
  shadowing ref and asserts the leased worktree stands on the captured commit.

- **2026-07-31, review round 1 (Intent Conformance Judge).** Two findings, both accepted; one
  was a real defect this phase's own tests had not been shaped to catch.

  **Accepted and fixed - "Treat infrastructure cleanup failures as infrastructure, never
  failed."** The executor resolved the lease before returning, as step 1 requires, but then
  returned the command's result whatever the cleanup had said. So a check that exited 0 while
  leaving a process group behind - the ordinary shape of a build that backgrounds a server -
  reported `passed`, the graph advanced, the run completed green, and a pooled worktree stayed
  held with nothing anywhere saying so. Worse, it made the retry gate this same phase added
  nearly unreachable: that gate lives on the `handleInfrastructureFailure` path, so a verdict
  slipping past cleanup means the gate is never consulted. The phase's own test had forced
  `infrastructure` AND an unprovable group together, which is the one combination where the
  hole is invisible.

  Fixed: any cleanup that does not resolve - a group not proven empty, a return that failed, a
  tree re-leased to somebody else while the command ran, or a throw out of the release - now
  returns `infrastructure` and outranks the command's result. The command's own outcome rides
  in the reason rather than being dropped, because "the build failed and then cleanup broke"
  and "the build passed and then cleanup broke" need different things done about them. Three
  tests changed shape to match: the two cleanup cases now assert a *passing* command is
  withheld, and the retry-gate test is driven by exit 0 rather than by an infrastructure result,
  which is what makes it fail against the unfixed code.

  **Partly accepted - "Consume Phase 2 and Phase 3 contracts unchanged and add no interface."**
  Three of the four flagged additions were removed rather than defended: `checks.ts` is back to
  its shipped bytes with `CheckAttemptRef` moved into this phase's own module (deviation 2
  above), and `terminateLiveCheckGroups` is gone in favour of Phase 3's published
  `killLiveCheckGroups` (deviation 7). The fourth, `handOffForReclaim`, could not be removed
  without reintroducing a leaked pool slot, and went to the operator as the finding's own text
  invites - see deviation 4 for the decision.

  Writing the `stop()` fix also surfaced a flaw in this phase's own test: it used the suite's
  state directory as a stand-in leased worktree, so it passed only when another test had run
  first. It now owns a directory outside `MISSION_HOME`, and passes alone.

  **Manual verification, both required scenarios, on a real repository with a real treehouse
  pool and a real `claude` session in a tmux pane:**

  - *The headline.* A `typecheck` command that fails: the check ran, exited 2, **failed the
    submission**, and the repair packet reached the pane carrying the command's own output
    (`src/thing.js(1,1): error TS2345: …`). The session fixed the file and committed. Round 2
    re-ran the check against the new commit, it exited 0 and **passed**, and the run completed.
    The lease was returned in both rounds and `treehouse status` ended `available`.
  - *Crash recovery.* `kill -9` of the daemon mid-check, with a command that had left a
    background process in its group. The group survived (reparented to init) and the lease row
    survived as `held` carrying its non-sentinel composite identity, with the tree still leased
    under `mission-control-check-<attemptId>`. On restart, reconciliation matched that identity,
    tore the group down, proved it empty, and only then returned the tree.
  - *The reaper never touched it.* Proven directly rather than by waiting: `reapPool` was run
    against that pool with **all three pin sources empty**, and refused - *"it is leased to
    mission-control-check-…; we only return our own leases"*. That is Contract L layer 1 with
    the defence-in-depth pin deliberately removed.
  - *Shutdown with a live check.* `SIGINT` to the daemon while a 300-second command was running:
    **0.65 seconds**, no orphan process, the pooled worktree back in the pool, every lease row
    terminal. Re-run after the teardown was switched to `killLiveCheckGroups` in review round 1,
    because that swap is exactly the kind of change a passing unit test would not have noticed.
  - *And the headline again, after review round 1*, since making cleanup failures outrank the
    command's result touches every check that succeeds: the gate failed a submission at exit 2
    with its own output, and after the fix was committed it ran again and passed at exit 0 with
    the run completing. It also demonstrated the pin unprompted - a submission captured before
    the check script existed ran in a worktree pinned to that commit and failed on the script
    being absent, which is the right answer about the wrong-looking thing.

- **2026-07-30, Inspector round 5 (PR #326), consumed here:** the finding landed on Phase 2
  (startup reconciliation returning a lease whose group may still be live) and its fix spans
  three phases: Phase 2 declares the `CheckGroupRecovery` seam with a refusing default, Phase 3
  implements it, and this phase injects it. Added to step 2 and to the exit criteria, with a
  test that asserts a real return rather than the default refusal - because a missing injection
  is invisible otherwise: everything still passes, and the daemon just keeps a pool slot per
  restart.
