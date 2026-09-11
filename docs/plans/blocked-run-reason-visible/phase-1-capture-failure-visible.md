# Phase 1: Capture failure explains itself

Part of [`phased-plan.md`](phased-plan.md). Approved goal: [`plan.md`](plan.md).

## Outcome

An operator who opens a workflow run blocked by evidence capture reads, on the run page and without
opening any disclosure: what failed, **which evidence item** failed, that nothing was reviewed and no
repair round was spent, and that **resubmit rather than resume** is the move that works. If the
session has since finished again and been refused, they read that too.

This closes the reported incident. Run `c29cc7cb` was blocked for two hours with the correct
explanation sitting unread in `gate_state_json`.

## Entry criteria and dependencies

- Direct phase dependencies: **none**. Depends only on the planning session's pull request, which
  publishes this file.
- May run concurrently with Phase 2.

## Scope

1. A `capture_failure` arm on the `WorkflowGateDetail` union, with a `workflowCaptureFailure`
   accessor.
2. A capture-family case in `runRefusedSentence`, rendered beside the resubmit button.
3. The failing evidence item's identity, attached at the throw site and persisted in the phase
   detail.
4. Wording and promotion for a refused Foreman completion claim on run detail.

## Non-goals

- **The clause map.** `BLOCKED_PHASE_CLAUSES`, its move to `src/shared/`, the alert body, and the
  twelve unnamed phases are Phase 2. Do not add an `image_evidence_capture` entry here; it would
  collide with Phase 2's rewrite of the same map.
- **Making the daemon accept a fresh claim on a blocked run.** `store.ts:6630` keeps refusing and
  keeps retiring the guard. This phase makes the refusal legible, nothing more. The behavioral fix is
  a separate plan.
- **Relaxing the capture guard.** Refusing a changed image is correct.

## Repository findings

Verified against the checkout, not assumed from the source plan.

- `WORKFLOW_RUN_PHASE_DETAIL_KEYS` (`src/shared/workflow-lifecycle.ts:353`) already declares
  `image_evidence_capture: ["error", "code"]`, `capture_error: ["error", "code"]`,
  `capture_interrupted: ["error"]` and `stale_capture: ["error"]`. `decodeDetail` returns `opaque`
  for all four today.
- The `check_cleanup` precedent is small: a 1-line union arm (`workflow-lifecycle.ts:454`), a 5-line
  interface, an 8-line `checkCleanupBlock` validator (`:549`), a branch in `decodeDetail` (`:623`),
  and a 7-line accessor (`:646`). Follow it exactly.
- `runRefusedSentence` (`src/web/workflows/run-model.ts:1616`) exists for precisely this shape - *"a
  run that still has a move"* - and switches on `detail.run.currentPhase`. It already renders at
  `WorkflowRuns.tsx:2858` into `<p className="wf-run-refused">`, styled at `styles.css:1776`. No new
  markup slot is needed.
- `inspectReservedSource` (`src/server/workflows/images.ts:588`) holds the whole
  `WorkflowReservedEvidence` row - which extends `WorkflowStagedEvidenceWrite` and therefore carries
  `clientItemId`, `displayName` and `sourceLocator` (`store.ts:2533`) - at the moment it calls
  `inspectOpenFile` with the `expected` identity. The error thrown at `images.ts:262` names none of
  them.
- The capture failure is caught in `manager.ts:6752`, which writes
  `{ error: message, code: error.code }` into the phase detail.
- **Step 4 needs no new data path.** `WorkflowRuns.tsx:2684` already derives `completionClaims` from
  `workflow_completion_claimed` events *including* `state`, and renders them at line 3444 under
  *Foreman completion claim*. The swallowed claim already appears there as the bare word "blocked" in
  a card head. This is a wording and promotion change.
- `WorkflowRun.gateState` is `WorkflowJson | null` (`src/shared/workflow.ts:3656`) and already
  reaches the browser. `src/shared/workflow-lifecycle.ts` is browser-safe and `WorkflowRuns.tsx`
  already imports from it. **No route, wire-format or migration work.**

## Implementation steps

### 1. `src/shared/workflow-lifecycle.ts` - decode the payload

- Add `WorkflowCaptureFailure { error: string; code: string | null; itemName: string | null;
  itemClientId: string | null }` beside `WorkflowCheckCleanupBlock`.
- Add `| { kind: "capture_failure"; failure: WorkflowCaptureFailure }` to `WorkflowGateDetail`.
- Add a `captureFailure(detail)` validator mirroring `checkCleanupBlock`: require a non-empty string
  `error`; accept `code`, `itemName` and `itemClientId` as strings or null.
- Branch in `decodeDetail` for the capture-family phases, phase-first, as the existing branches are.
  Ordering matters for the same reason the file already documents: `capture_error` and
  `image_evidence_capture` persist the same keys, and the phase is what tells them apart.
- Export `workflowCaptureFailure(record)`, gated on `lifecycle.executable` like its two siblings.
- Extend `WORKFLOW_RUN_PHASE_DETAIL_KEYS.image_evidence_capture` to
  `["error", "code", "itemName", "itemClientId"]`. The whitelist is allowed-key, not required-key, so
  existing rows that carry only `error` and `code` keep decoding.

### 2. `src/server/workflows/images.ts` - name the failing item

- In `inspectReservedSource`, wrap the three `inspectOpenFile` calls so a thrown
  `WorkflowImageEvidenceError` is re-raised carrying `item.displayName` and `item.clientItemId`.
  Prefer adding optional fields to `WorkflowImageEvidenceError` (`evidence-error.ts`) over encoding
  the name into the message string, so the phase detail keeps structured fields and the sentence
  composes them.
- Do not change any error `code`. Existing callers and tests switch on those.

### 3. `src/server/workflows/manager.ts` - persist the identity

- At the capture-failure catch (`:6752`), include `itemName` and `itemClientId` in the phase detail
  when the error carries them. Omit the keys entirely when it does not; the decoder treats absent and
  null alike.

### 4. `src/web/workflows/run-model.ts` - the sentence

- Add a capture-family case to `runRefusedSentence`, reading the decoded failure from
  `detail.run.gateState` via `workflowCaptureFailure`.
- Name the item when it is known and degrade cleanly when it is not - a run blocked by a build that
  predates step 2 carries no identity, and guessing is worse than a general sentence.
- The sentence must state all three facts: the cause, that no round was spent, and that resubmit is
  the working recovery. The third is the one the operator cannot derive:
  `resumeImageEvidenceCapture` (`manager.ts:1876`) deliberately replays *the same immutable
  reservation*, so on this failure resume is guaranteed to fail identically.

  > Evidence capture refused this round: `steering-context.png` (`phase2-steering-disclosure`)
  > changed after it was staged. Nothing was reviewed and no repair round was spent. Re-register the
  > screenshot, then resubmit - resuming would re-check the same stale reservation and stop here
  > again.

- Do **not** touch `runNoMoveReason`. Its invariant - a move and an excuse never render together - is
  correct and is not what failed here. `runRefusedSentence` is the slot that already renders
  alongside a move.

### 5. `src/web/workflows/WorkflowRuns.tsx` - the refused claim

- Give the *Foreman completion claim* card real wording for `state === "blocked"`: the claim was
  refused, it produced no submission, and the evidence it registered is staged and waiting.
- Promote it. When a refused claim is the newest completion event on a blocked run, say so in the
  header near the refused sentence, with its age.
- Display only. Nothing here posts, retries, or changes what the daemon does with the claim.

## Data and compatibility

- No migration. `gate_state_json` is an untyped JSON column and the two new keys are additive and
  optional.
- Forward: a row written before this phase carries `error` and `code` only, decodes to
  `capture_failure` with null identity, and renders the general sentence.
- Backward: a row written *by* this phase and read by an older build decodes to `opaque`, which every
  accessor already refuses to hand to an executable path. No older build crashes on it.
- `test/workflow-run-lifecycle.test.ts` pins the phase-detail contract; the new keys must be added
  there or that test fails, which is the intended tripwire.

## Tests and verification

- `test/workflow-run-lifecycle.test.ts` - the new arm decodes with and without the identity; a
  non-capture phase carrying `error` still decodes `opaque`; a terminal run is not `executable`.
- `test/workflow-runs-model.test.ts` - the sentence names the item when present and degrades when
  absent; the refused-claim sentence appears only when a refused claim is the newest completion event
  on a blocked run.
- `test/workflow-run-next-move.test.ts` - the sentence renders **with** the resubmit move, not
  instead of it. This is the regression that caused the incident.
- Server-side coverage for the error carrying the item identity, in the existing image-evidence test
  file (`test/workflow-image-evidence.test.ts` already asserts `image_changed` at line 806).
- **A new spec in `e2e/specs/`.** Seed a blocked `image_evidence_capture` run through `withDaemonDb`
  (`e2e/specs/workflow-evidence-reserved-refusal.spec.ts` is the working precedent) and assert the
  operator reads the cause, the item name and the resubmit instruction on run detail with no
  disclosure opened. Select by role and label; no `data-testid`. This is a UI change, so the spec is
  not optional.
- `npm run typecheck`, `npm run lint`, and `npm run build && npm run test:e2e`.

## Merge and exit criteria

- All of the above green.
- A blocked capture run states its cause, its item, its cost and its remedy on run detail.
- No change to any error `code`, to `runNoMoveReason`, or to what the daemon does with a refused
  claim.

## Downstream handoff

Later work may rely on:

- `workflowCaptureFailure(record)` and the `capture_failure` arm as the single typed reader of a
  capture-family phase detail. Add readers; do not re-parse `gateState` at a call site.
- `WORKFLOW_RUN_PHASE_DETAIL_KEYS.image_evidence_capture` carrying the optional identity keys.
- `runRefusedSentence` as the home for "the daemon refused, and there is still a move" copy.

Must not change: the error `code` vocabulary, `runNoMoveReason`'s invariant, or `blockedPhaseClause`
(Phase 2 owns it).

## Cross-phase audit record

- **Written first.** Checked against the source plan's seven steps: this phase owns 1, 2, 4 and 7;
  Phase 2 owns 3, 5 and 6.
- Deliberately does **not** add an `image_evidence_capture` entry to `BLOCKED_PHASE_CLAUSES`, even
  though the source plan's step 3 sits textually beside step 2. Phase 2 moves that whole map to
  `src/shared/`; an entry added here would be a guaranteed conflict for no benefit before Phase 2
  merges.
- Confirmed no dependency on Phase 2: `runRefusedSentence` composes its own prose and never calls
  `blockedPhaseClause`.
