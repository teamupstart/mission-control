# Phase 5: Local review replaces the GitHub round

Source plan: `docs/plans/local-inspector-review/plan.md`. Index:
`docs/plans/local-inspector-review/phased-plan.md`.

## 1. Outcome

A change reviewed by the Local Inspector is pushed once, runs CI once, and completes its
workflow without a GitHub Inspector review. This is the phase that removes the repeated CI
runs the plan set out to remove.

## 2. Entry criteria and dependencies

- Direct dependency: Phase 4 (Local Inspector Command) is merged.
- Operator decision, not enforced by the task graph: the Phase 4 measurement of GitHub rounds
  remaining after a local pass is in before this phase is dispatched.

## 3. Scope and non-goals

In scope: No-Mistakes version 23, the completion gate's local path, the worker skipping
matched heads, the `local` posture value, the chip and Completion tab states, Settings copy.

Not in scope: the merge predicate. Until Phase 6, Shipping keeps refusing a `local` posture.
No change to Personas, to the slot, or to what Phase 4 records.

## 4. Repository findings and inherited contracts

- Built-in versions are appended in `src/server/workflows/builtin-workflows.ts`.
  `appendCodeRabbitVersion` is the model for adding one evaluation stage.
- `evaluateInspectorGate` in `src/server/workflows/manager.ts` pins the adopted pull request and
  compares its head tree with the submission's publication tree.
- `processPr` in `src/server/inspector/worker.ts` observes first, then replies, merges and
  reviews. It takes a `workflowGate` callback from the manager.
- Inherited from Phase 4: the recorded outcome and its publication tree, and that "passed"
  means reviewed with repository access.

## 5. Implementation steps

1. Append No-Mistakes version 23: version 22 plus one evaluation stage holding an `inspector`
   check node, placed last before the Pull Request action. The node id is new. The completion
   policy is version 22's.
2. In the workflow manager, add the single owner of "does this head match a passed local
   review": the run's latest submission has a passed, not skipped, Local Inspector attempt,
   and the head's Git tree equals that submission's publication tree. The match is by tree
   and base branch, not by commit: a later commit with the same tree still matches, and the
   worker records the new head on its next sweep. Until Phase 6 the
   answer is always no for a repository holding the merge grant, so the gate and the worker
   keep the GitHub review for every head there.
3. In `evaluateInspectorGate`, when `localReview` is on and the submission has a passed local
   review, satisfy the gate on that match with no GitHub review. A different head keeps the
   existing `head_mismatch` wait. A skipped or absent stage keeps the GitHub path. Record
   which path the gate took.
4. Append `local` to `INSPECTOR_POSTURES` in `src/shared/inspector.ts`. Make
   `reviewNeedsLiveRerun` leave a matched `local` head alone while `localReview` is on. A
   matched head recorded under Dry run is recorded again as `local` on the first sweep after
   the operator switches to Live, with no GitHub review, because the match still holds.
5. In `processPr`, ask the manager for the match after observation. On a match: answer no
   thread, run no review and post nothing. Record the head with posture `local` only while the
   Inspector's current posture for the repository is `live`. In Dry run, or on a repository not
   on the Inspector's list, record the current posture (`dry-run` or `not-allowlisted`), as a
   dry review is recorded today, so Dry run never produces a `local` head. Observation,
   CodeRabbit follow-up, the stack lifecycle and the merge check still run.
6. Show the state: the session chip and the Completion tab say the head was reviewed locally
   and list the attempt's findings. Update the Settings copy for the Local review control.
7. Decide and record whether local findings are mirrored into the Inspections table at
   adoption. The default is no: they stay run data.
8. Update `docs/workflows.md` and `docs/inspector-and-shipping.md`.

## 6. Data, API and compatibility

- The posture value and the new node id are appended. No existing version, node id or policy
  changes. Bindings pinned to version 22 or earlier behave as before.
- With the flag or setting off, version 23 behaves as version 22: the stage skips.
- A head that does not match is an "other head" and keeps today's GitHub review.
- Until Phase 6, a repository holding the merge grant keeps the GitHub review for every head.
- A `local` posture is only ever recorded under a Live Inspector. Dry run records `dry-run`
  for a matched head, so the merge predicate's existing checks keep Dry run dry.
- A later commit with the same tree and base still matches. Only a push that changes the tree
  is an "other head".
- A run whose repair budget ends while the Local Inspector still fails stops before the Pull
  Request action. The gate is never reached and no GitHub review starts for it.

## 7. Tests and verification

- Gate tests in `test/workflow-inspector-gate.test.ts`: a matching tree completes, a later
  commit with the same tree still completes, a head with a different tree does not, a skipped
  stage falls back, a repository holding the merge grant falls back, a restart keeps the
  recorded path.
- Worker tests: a matched head gets no review, reply or post, and observation continues. A
  matched head in Dry run is recorded as `dry-run`, and as `local` after a switch to Live.
- Built-in catalog tests for version 23 and for unchanged earlier versions.
- A version 23 run that spends its repair rounds on the Local Inspector blocks at `round_limit`
  and opens no pull request.
- Playwright: the version 23 pipeline, the Completion tab's local state and the chip.
- Run `npm run typecheck`, `npm run lint`, the focused tests, `npm run build`,
  `npm run smoke` and `npm run test:e2e`.

## 8. Merge and exit criteria

- A converged change on version 23 reaches GitHub with one push and one CI run and completes
  with no GitHub review and no comment.
- A later push with different content is reviewed on GitHub as today. A later commit with the
  same tree and base still matches and gets no GitHub review.
- Shipping still refuses a `local` posture, and no repository holding the merge grant records
  one.
- With the Inspector in Dry run, a matched head gets no GitHub review and is never recorded as
  `local`.

## 9. Downstream handoff

Phase 6 may rely on the manager's match question and on the `local` posture recorded for a
matched head, which is only ever recorded under a Live Inspector. It must not add a second
owner of the match. It removes the merge-grant exception.

## 10. Cross-phase audit record

- 2026-11-23: checked against Phase 4. This phase reads the recorded outcome and adds no field
  to it.
- 2026-11-23: checked against Phase 6. The posture is introduced here and accepted there, so
  no state exists in which Shipping accepts a posture no phase has defined.
- 2026-11-23: reconciled with the source plan's design item 7. Until Phase 6, a repository
  holding the merge grant keeps the GitHub review for every head, so no head is left without
  merge provenance between the two phases.
- 2026-11-23: reconciled with the source plan's rule that Dry run means dry for the merge. The
  `local` posture is recorded only under a Live Inspector, and Phase 6 keeps the merge
  predicate's current-posture gate first.
- 2026-11-23: later reviews. The match is stated as by tree and base branch, so a later commit
  with the same tree still matches, and a run that spends its repair budget on the Local
  Inspector never reaches this phase's gate.

## 11. Implementation record

What was built, and where it follows or departs from the route above.

### The exact-content match decision

`WorkflowManager.localReviewMatch(prKey, { headSha, baseRefName })` in
`src/server/workflows/manager.ts` is the one owner of "does this pull request head match a
passed local review". The completion gate and the Inspector worker both reach the same private
`matchLocalReview`, and nothing else decides it. A head matches only when all of these hold:

- `InspectorConfig.localReview` is on (it reads as off while the `local-inspector` flag is off).
- The repository does not hold the Shipping merge grant (`repositoryHoldsMergeGrant` in
  `src/server/shipping/config.ts`: on Shipping's allowlist, whether or not YOLO is armed; an
  unreadable setting counts as holding it).
- The run's version has at least one `inspector` check node, and on the run's latest submission
  (a Pull Request continuation segment reads its parent segment's attempts) every such node's
  latest attempt completed with check status `passed` and Local Inspector status `passed`, all on
  one publication tree and base ref. Skipped, failed and blocked never match.
- The pull request's base branch equals the branch the review compared against
  (`localReviewBaseBranch` reads `refs/remotes/<remote>/<branch>`, `refs/heads/<branch>` or
  `origin/<branch>`; anything else matches nothing).
- `git rev-parse <head>^{tree}` equals the recorded publication tree. The match is by tree, so a
  re-created commit with the same tree still matches. A head git cannot resolve does not match.

The worker asks about the runs that own the pull request, newest first, and the newest decides.
A run owns the pull request only on direct evidence: its gate pinned the key, or its own Pull
Request action recorded the key as the pull request it opened (completed runs included, so a
matched head stays matched after the workflow finishes). A run that merely shares the session and
repository is not an owner. A newer owner whose version has no Local Inspector stage, or whose
latest attempt skipped, failed or blocked, is no match even when an older run passed the same
tree, because that newer run's gate waits for the GitHub review. A newer owner that was cancelled
or failed is no match too: it never finishes a local review. So is a newer owner in
`waiting_for_new_head`, repairing GitHub findings, which keeps the worker answering those threads
exactly as the run's gate keeps the GitHub path. Only while the newer run's Local
Inspector review is still pending (a node queued, running or waiting, or a round that has not
reached the stage) in a run still going does an older run's pass keep vouching for a head it
already reviewed.
The gate asks only about its own run.

### Gate and worker behavior

- Gate: in `evaluateInspectorGate`, after a fresh observation of an open, pinned pull request and
  before the existing head and publication checks, a match completes the run with
  `localReview: { submissionId, attemptId, headSha, treeOid, baseRef }` in the gate state and an
  `inspector_gate_clean` event carrying `path: "local"`. The GitHub path's clean event carries
  `path: "github"`. A run in `waiting_for_new_head` (repairing GitHub findings) stays on the
  GitHub path. A completed run keeps the recorded path across restarts.
- Worker: `processPr` asks the manager after observation, through the `localReview` option the
  daemon passes beside `workflowGate`. For a matched head it answers no thread, starts no review
  and posts nothing; observation, the CodeRabbit follow-up, the stack lifecycle and the merge
  check still run. It records the head with `localReviewHeadSha` (new nullable
  `inspector_prs.local_review_head_sha` column) and review posture `local` under a Live Inspector,
  or the current posture (`dry-run`, `not-allowlisted`) otherwise. A matcher failure counts as no
  match. A head recorded from a local match is never reused as a completed review: once it stops
  matching it is reviewed on GitHub in every posture, Dry run included, and that review clears
  the local record.
- `local` is appended to `INSPECTOR_POSTURES`, and the gate state schema now reads its posture
  from that list. The merge predicate is unchanged and refuses `local` as an unpublished review.

### Built-in version

No-Mistakes Review version 23 (`appendLocalInspectorVersion` in
`src/server/workflows/builtin-workflows.ts`) is version 22 plus one evaluation stage holding the
check node `nmr-check-local-inspector` (slot `inspector`), immediately before the Pull Request
action. Its pass reaches the action and its fail returns to the session. Completion policy,
resumption, evidence readiness and binding defaults are version 22's. A digest test pins versions
1 to 22 as byte-identical to what shipped.

### Fallbacks that keep the GitHub review

A head with a different tree or base, a skipped or failed stage, Local review off, a version
without the stage (every binding pinned to version 22 or earlier), a pull request opened outside a
workflow, and every head in a repository holding the merge grant all keep today's GitHub review.
On the gate a different head waits on `head_mismatch` as before. On the worker a head recorded from
a local match that stops matching is reviewed on GitHub in every posture: posted in Live, recorded
without posting in Dry run. That review clears the local record.

### Surfaces

The session chip reads "reviewed locally before the pull request opened" for a head whose
`localReviewHeadSha` equals the observed head. The Completion tab shows "Reviewed locally", the
head and tree, and the Local Inspector findings. The Settings Local review card, the findings
modal notice, `docs/workflows.md`, `docs/inspector-and-shipping.md` and the library tour are
updated. Step 7: local findings are not mirrored into the Inspections table; they stay run data.

### Deviations from the route

- `reviewNeedsLiveRerun` keeps its signature. The worker records a still-matching head and returns
  before that question, so a `local` head reaching it no longer matches and is reviewed on GitHub.
- The worker reads ownership from the gate pin and the Pull Request action's record rather than
  from `matchesUnpinnedGate`'s session and repository rule, and lets an older owner's pass stand
  only while the newest owner's review is pending, for the reasons above.
- The ledger gained one column so the chip can show the local state in Dry run, where the recorded
  posture is not `local`.
- The version 23 round-limit case is covered by the catalog test of the stage's fail route and the
  Phase 4 Playwright round-limit spec on the same graph shape, not by a new engine-level run.

### Proving one push and one CI run

The Playwright spec asserts one new branch ref on the origin for the published change. CI is
modelled where GitHub starts it: the fake GitHub records one CI run when it first reports an open
pull request at a head (`pull_request` opened) and one more for each later head (`synchronize`),
read back with `readGhCiRuns`. On the local path the ledger holds exactly one run for the reviewed
head, and it still holds one after two further Inspector sweeps, with no Inspector feedback packet
sent to the session. A later push with different content adds the second run, on the GitHub path.

### Known issue found during verification

An Inspector sweep that lands inside the Pull Request action's repository capture can make that
capture fail with "The repository changed during both capture attempts". It reproduces with the
local match disabled, so it predates this phase. `e2e/specs/local-review-gate.spec.ts` keeps the
fake GitHub from reporting the pull request until the gate is waiting, so no Inspector observation
can land inside that capture.
