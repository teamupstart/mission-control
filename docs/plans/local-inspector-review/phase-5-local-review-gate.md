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
   and the head's Git tree equals that submission's publication tree. Until Phase 6 the
   answer is always no for a repository holding the merge grant, so the gate and the worker
   keep the GitHub review for every head there.
3. In `evaluateInspectorGate`, when `localReview` is on and the submission has a passed local
   review, satisfy the gate on that match with no GitHub review. A different head keeps the
   existing `head_mismatch` wait. A skipped or absent stage keeps the GitHub path. Record
   which path the gate took.
4. Append `local` to `INSPECTOR_POSTURES` in `src/shared/inspector.ts`. Make
   `reviewNeedsLiveRerun` leave a matched `local` head alone while `localReview` is on.
5. In `processPr`, ask the manager for the match after observation. On a match: answer no
   thread, run no review, post nothing, and record the head with posture `local`.
   Observation, CodeRabbit follow-up, the stack lifecycle and the merge check still run.
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

## 7. Tests and verification

- Gate tests in `test/workflow-inspector-gate.test.ts`: a matching tree completes, a moved head
  does not, a skipped stage falls back, a repository holding the merge grant falls back, a
  restart keeps the recorded path.
- Worker tests: a matched head gets no review, reply or post, and observation continues.
- Built-in catalog tests for version 23 and for unchanged earlier versions.
- Playwright: the version 23 pipeline, the Completion tab's local state and the chip.
- Run `npm run typecheck`, `npm run lint`, the focused tests, `npm run build`,
  `npm run smoke` and `npm run test:e2e`.

## 8. Merge and exit criteria

- A converged change on version 23 reaches GitHub with one push and one CI run and completes
  with no GitHub review and no comment.
- A later push with different content is reviewed on GitHub as today.
- Shipping still refuses a `local` posture, and no repository holding the merge grant records
  one.

## 9. Downstream handoff

Phase 6 may rely on the manager's match question and on the `local` posture recorded for a
matched head. It must not add a second owner of the match. It removes the
merge-grant exception.

## 10. Cross-phase audit record

- 2026-11-23: checked against Phase 4. This phase reads the recorded outcome and adds no field
  to it.
- 2026-11-23: checked against Phase 6. The posture is introduced here and accepted there, so
  no state exists in which Shipping accepts a posture no phase has defined.
- 2026-11-23: reconciled with the source plan's design item 7. Until Phase 6, a repository
  holding the merge grant keeps the GitHub review for every head, so no head is left without
  merge provenance between the two phases.
