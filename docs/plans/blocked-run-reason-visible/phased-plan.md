# Phased implementation: say why a workflow run is blocked

Source plan: [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html))
Investigation behind it: the blocked-run diagnosis delivered in the planning session. Report artifacts
are not committed (repository policy), so its findings are restated below rather than linked.

## Incorporated decisions

Submitted in the Mission Control dashboard on 10 September 2026. All five are requirements below,
not open questions.

| Decision | Adopted | Owned by |
| --- | --- | --- |
| Which surfaces carry the reason | All four, including the alert; `BLOCKED_PHASE_CLAUSES` moves into `src/shared/` | Phase 2 |
| Name the failing evidence item | Yes; `inspectReservedSource` attaches `displayName` and `clientItemId` | Phase 1 |
| Phase coverage | The whole capture family, plus an exhaustiveness test over `WORKFLOW_RUN_PHASES` | Phase 2 |
| The swallowed second completion | Show it, do not fix it here | Phase 1 |
| After this plan | Create phased implementation plan and schedule the tasks | this document |

## What the repository investigation changed

Three findings moved work between the source plan's steps. Recorded here rather than silently
applied.

**1. Fourteen blocked phases render as their own identifier, not four.** The source plan treats the
missing clause as a capture-family problem. Diffing `BLOCKED_PHASE_CLAUSES` (17 keys) against the 27
phases whose declared statuses in `WORKFLOW_RUN_PHASE_STATUSES` include `blocked` leaves **12 with no
entry**:

```
capture_interrupted            delivery_recovery_error       preflight_refinement_exhausted
check_cleanup_unresolved       external_artifact_mismatch    session_action_blocked
conversation_changed           image_evidence_capture        unchanged_repository
delivery_prepare_error         pr_handoff_prepare_error      inspector_pr_switch_refused
```

Two more - `delivery_blocked` and `delivery_refused` - *are* mapped, to a value
character-for-character identical to what the fallback already produced, so mapping them changed
nothing a reader sees. Fourteen in total, and the second blocked run sitting in the operator's state
database right now (`06438d27`, `preflight_refinement_exhausted`) is one of them. This is a
vocabulary gap across the product, not a capture bug, and it is why the naming work is its own phase
rather than three lines inside the capture fix.

Those two mapped-but-identical entries are why Phase 2's guard asserts that a clause **differs from**
`phase.replaceAll("_", " ")` rather than merely that a key exists. A key-existence check is known to
be insufficient here, not suspected to be.

**2. The exhaustiveness test must be one-directional.** `BLOCKED_PHASE_CLAUSES` legitimately holds
two keys that are *not* blocked-capable - `unchanged_evidence` and `reattached_resubmit_required` -
because the triage column also renders parked runs. The guard asserts every blocked-capable phase has
an entry; it must not assert the converse.

**3. Step 7 needs no new data path.** The source plan proposes surfacing the refused completion
claim. `WorkflowRuns.tsx:2684` already derives `completionClaims` from
`workflow_completion_claimed` events including their `state`, and renders each one at line 3444
under *Foreman completion claim*. The swallowed claim is already on the page - as the bare word
"blocked" in a card head, with nothing saying it means the claim produced no submission. The work is
wording and promotion, not plumbing, which is why step 7 stays inside Phase 1 rather than earning its
own.

## Sizing and phase count

Estimated **300 to 340 gross non-test implementation lines**, at this repository's comment density
(the `check_cleanup` decoder precedent is 8 lines of logic under 12 lines of prose, and every map
entry here carries a justification comment). Assumptions: no route, wire-format or migration work
(`WorkflowRun.gateState` already reaches the browser); roughly 60 of those lines are relocation
rather than new logic; the fourteen clause entries are ~2 lines each plus the judgement to write them.

That is above the 200-line one-phase threshold, so the default is still one phase and a second has to
earn itself. **Two phases**, and the case for the split:

> Phase 2 is not a layer of Phase 1 and does not consume anything Phase 1 produces. It is fourteen
> independent wording decisions across delivery, Inspector, session-action and preflight
> subsystems - each needing its author to understand a phase that has nothing to do with evidence
> capture - plus a shared-module relocation that changes notification behavior. Combining them
> would hold the reported bug's fix behind thirteen unrelated research questions, and would put a
> persisted server payload change, a `src/shared/` move, fourteen copy decisions, two browser specs
> and five unit test files into one review. Split, each phase is one reviewable claim with its own
> spec.

Nothing smaller was carved out. There is no preparation, test-only or documentation phase: the
decoder arm ships with its first consumer, and each phase's tests and docs are its own.

## Phases

| # | Phase | File | Depends on | Repository |
| --- | --- | --- | --- | --- |
| 1 | Capture failure explains itself | [`phase-1-capture-failure-visible.md`](phase-1-capture-failure-visible.md) | planning session only | mission-control |
| 2 | No blocked phase goes unnamed | [`phase-2-blocked-phase-vocabulary.md`](phase-2-blocked-phase-vocabulary.md) | planning session only | mission-control |

Both phases live wholly in the source-plan repository, so neither task sets `repository` or
`additionalRepositories`.

### Scheduled tasks

| Phase | Task id | Direct prerequisites |
| --- | --- | --- |
| 1 | `f28d0e9d-be66-436f-adbf-ba4e82b8df58` | this planning session |
| 2 | `2ac6c33c-d819-40e6-93a0-28c791aed0be` | this planning session |

Both sit in the backlog and are released by this planning pull request's merge, which is what
publishes the phase files their intents point at. Neither depends on the other.

## Dependency graph

```
  planning session PR (publishes these artifacts)
        |
        +------------------+
        |                  |
     Phase 1            Phase 2
  capture failure     blocked-phase
  explains itself      vocabulary
```

**Concurrency group: Phase 1 and Phase 2 may run at the same time and merge in either order.**
Neither consumes a file, contract, migration or decision the other owns. Both edit
`src/web/workflows/run-model.ts`, but in different functions roughly 550 lines apart - Phase 1 in
`runRefusedSentence`, Phase 2 in `BLOCKED_PHASE_CLAUSES` and `blockedPhaseClause` - so the overlap is
a textual merge, not a semantic one. Whichever lands second rebases.

Either merge order leaves a coherent product:

- Phase 1 first: run detail explains the capture failure; the Line strip still prints the phase code.
- Phase 2 first: every surface names the phase; run detail still does not say what to do about it.

## Cross-phase contracts

These are the only things one phase promises the other, and neither may change them unilaterally.

| Contract | Owner | What the other phase may rely on |
| --- | --- | --- |
| `WorkflowGateDetail` gains a `capture_failure` arm and a `workflowCaptureFailure` accessor in `src/shared/workflow-lifecycle.ts` | Phase 1 | Phase 2 does not read it. If Phase 2 lands first it must not restructure the union. |
| `blockedPhaseClause` keeps its name, its `(phase: string) => string` signature, and its unmapped fallback | Phase 2 | Phase 1 does not call it, but `run-actions.ts:981` does. Moving it must not change what an unmapped code renders as. |
| `WORKFLOW_RUN_PHASE_DETAIL_KEYS.image_evidence_capture` gains two optional keys | Phase 1 | Phase 2 does not read phase detail. |
| Run detail's `.wf-run-refused` slot renders the capture sentence | Phase 1 | Phase 2 adds nothing to run detail's header. |

## Final verification

After both phases merge:

- `npm run typecheck` and `npm run lint`.
- `npm test` - the decoder arm, the sentence selectors, the clause map exhaustiveness guard, the
  alert body, and the Line strip grouping.
- `npm run build && npm run test:e2e` - both phases' specs, since each changes a UI surface.
- A blocked `image_evidence_capture` run reads, without opening any disclosure: what failed, which
  evidence item, that no repair round was spent, and that resubmit rather than resume is the move.
- No phase whose declared statuses include `blocked` renders its own code in the Line strip, the
  Review drawer, the Runs rail, or a notification.
