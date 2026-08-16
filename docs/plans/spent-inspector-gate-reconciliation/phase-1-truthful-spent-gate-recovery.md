# Phase 1: Truthful Spent-Gate Recovery

## Outcome and value

A spent workflow Inspector gate stops presenting historical findings as current truth. Every workflow surface distinguishes the last workflow observation from the current Inspector ledger, and a clean exact current head offers one safe action, `Adopt clean Inspector head`, which reuses the existing audited grant and evaluator path.

Direct callers can no longer request a Recheck that reports success while the blocked-run guard guarantees a no-op.

## Entry criteria and direct dependencies

- `docs/plans/spent-inspector-gate-reconciliation/plan.md` is approved and merged.
- `docs/plans/spent-inspector-gate-reconciliation/phased-plan.md` is merged.
- This phase depends directly on the planning task that publishes those artifacts.
- The implementation starts from the default branch after that dependency is satisfied.

## Scope

1. Add one browser-side derivation for a spent Inspector gate's current condition.
2. Use it in the run detail, full ladder, compact ladder preview, next-move descriptor, and no-move explanation.
3. Reuse the existing `grant-rounds` mutation with contextual adoption copy for a clean exact current head.
4. Suppress the spent gate's Recheck action and make the daemon reject the same dead request.
5. Add focused unit, rendering, manager, and Playwright regressions.
6. Update `docs/workflows.md` to explain historical gate snapshots, current Inspector truth, and the contextual recovery action.

## Explicit non-goals

- No automatic completion of a blocked run.
- No second Inspector repair budget or workflow setting.
- No database migration, persisted enum, protocol field, route, SSE event, or Inspector poller.
- No change to Shipping gate order, merge eligibility, or compare-and-swap behavior.
- No rewriting of historical workflow gate state or finding fingerprints.
- No recovery action against the historical PR #591 run as verification.

## Repository findings and inherited contracts

### Detail already carries both records

`src/server/workflows/manager.ts` decorates `WorkflowRunDetail` with:

- `inspectorGate.state`, the immutable historical workflow observation;
- `inspectorGate.inspection`, the current Inspector ledger row with reviewed head, observed head and state, posture, and finding tallies;
- `inspectorGate.findings`, including resolved and unresolved rows.

Use those fields. Do not add a second fetch, browser polling, or a derived server snapshot.

### Mutation and completion already have one owner

`grantRepairRounds` raises the run-owned budget, appends `repair_rounds_granted`, and restores an Inspector-only run to `waiting_for_new_head`. `evaluateInspectorGate` then creates the immutable `inspector_only` submission on an eligible head and completes only after the same exact-head, live-posture, open-PR, and zero-open-finding checks used by normal operation.

The contextual action must POST to the existing `grant-rounds` route with the existing bounded rounds body. It must not write gate state or call completion directly.

### Existing presentation is historical-only

`gateWaitSentence` is correct for a live gate but incomplete for a spent gate because it reads only the historical `waitReason`. `inspectorGateActions` also emits Recheck for any non-null wait reason, even when `evaluateInspectorGate` refuses to act. The new derivation must be consumed rather than duplicated at those call sites.

## Implementation sequence

### 1. Model the current spent-gate condition once

In `src/web/workflows/run-model.ts`, add a detail-level discriminated result for the current condition of a spent Inspector-only gate. Use the existing `workflowRunGaveUp` predicate and current detail fields.

The result must distinguish at least:

- historical findings still open on the current reviewed head;
- historical findings resolved, but the current observed head is not yet reviewed clean;
- current exact observed head reviewed clean under live posture with zero open findings;
- missing, closed, stale, mismatched, or internally inconsistent evidence.

Fail closed. A clean result requires an open current observation, identical observed and reviewed heads, live review posture, zero open findings, and resolution of every historical fingerprint that is still represented in the current ledger. The helper returns presentation facts only and performs no mutation.

Keep existing live-gate copy unchanged. Add current-state copy helpers only for the spent-gate case so a normal wait still reads from `gateWaitSentence`.

### 2. Make action selection truthful

In `src/web/workflows/run-actions.ts`:

- keep the existing spent-run `grant-rounds` descriptor and route;
- when the shared derivation says the exact current head is clean, label it `Adopt clean Inspector head` and explain that the daemon will revalidate and create the audited Inspector-only submission;
- retain ordinary `Grant one more round` or `Grant 2 more rounds` copy for spent gates whose current evidence is dirty, pending, unavailable, or inconsistent;
- do not emit `recheck-inspector` from `inspectorGateActions` for blocked spent runs;
- preserve the repair ceiling, active-binding, external-source, idempotency, and confirmation guards.

`runNoMoveReason` must use the same derivation where a spent run cannot receive a grant, so it never falls back to historical current-tense findings copy.

In `src/server/workflows/manager.ts`, narrow `recheckInspector` to run states the evaluator can actually process. Preserve replay idempotency for accepted requests and return the existing `run_not_waiting` family for a blocked spent run. Do not change the evaluator's blocked-run guard.

### 3. Render history and current truth consistently

Update these existing consumers without creating parallel state rules:

- `src/web/workflows/WorkflowRuns.tsx`: split the final-gate presentation into `Last workflow observation` and `Current Inspector`, keep the historical failed head and findings auditable, and show current reviewed/observed head, posture, state, and open/resolved counts separately.
- `src/web/workflows/WorkflowLadder.tsx`: use the spent-gate sentence derived from current truth while retaining the historical facts beneath it.
- `src/web/workflows/WorkflowLadderPeek.tsx`: use the same sentence and status so the Board preview does not repeat the stale finding claim.
- `src/web/workflows/run-actions.ts`: ensure the header's primary and no-move prose agree with those surfaces.

Keep the existing Inspector footer location after End, the detail-only HTTP read, and the SSE summary unchanged. Add only scoped styles in `src/web/styles.css` if the two-record presentation needs them.

### 4. Pin the behavior at each boundary

Extend focused tests rather than building parallel fixtures:

- `test/workflow-run-next-move.test.ts`: clean exact head yields `Adopt clean Inspector head`; dirty, unreviewed, mismatched, closed, non-live, and unavailable evidence keep the ordinary grant or fail-closed explanation; a spent gate has no Recheck action.
- `test/workflow-runs-model.test.ts`: pin every derivation arm and historical fingerprint reconciliation.
- `test/workflow-runs-render.test.ts`, `test/workflow-ladder-render.test.ts`, and `test/workflow-ladder-peek.test.ts`: pin the two-record labels and consistent current-state sentence.
- `test/workflow-inspector-gate.test.ts`: after a spent-run grant, feed a later exact head that is reviewed live with zero open findings, then assert the immutable Inspector-only submission, audit event, and completed run. Also pin the blocked Recheck refusal without weakening accepted live waits.
- `e2e/specs/workflow-round-limit-grant.spec.ts`: extend the existing real-button fixture with a spent Inspector gate and a current clean Inspector ledger. Assert accessible text for historical versus current state, absence of Recheck, presence of `Adopt clean Inspector head`, the existing confirmation and POST, and observable workflow advancement. Continue using fake agents and role or label selectors only.

### 5. Document the operator contract

Update `docs/workflows.md` in the spent repair-budget and Inspector-gate sections:

- the gate snapshot records why the workflow stopped and remains historical;
- current Inspector status comes from the durable ledger already shown on run detail;
- a clean exact head does not silently release Shipping;
- `Adopt clean Inspector head` reuses the explicit grant and exact-head audit path;
- Recheck remains for live waiting gates and is absent from a spent blocked gate.

## Data, API, migration, and compatibility

- Database: no change.
- Shared protocol: no change.
- HTTP surface: no new route and no request-body change. The existing Recheck route becomes truthfully restrictive for a blocked spent state.
- SSE: no change. Full current Inspector evidence remains detail-only.
- Persisted history: unchanged and never rewritten.
- Older run rows: fail closed when detail lacks enough current Inspector evidence.
- Inspector and Shipping ownership: unchanged.

## Verification commands

Run the most focused tests first with the mandatory preload:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/workflow-runs-model.test.ts test/workflow-run-next-move.test.ts test/workflow-runs-render.test.ts test/workflow-ladder-render.test.ts test/workflow-ladder-peek.test.ts test/workflow-inspector-gate.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e -- e2e/specs/workflow-round-limit-grant.spec.ts
npm run smoke
```

If the focused Playwright invocation does not match the repository script's argument forwarding, run the full `npm run test:e2e` after `npm run build`, as required by the project contract.

Perform visual verification of the built dashboard for the spent historical gate with a clean current Inspector head. Keep evidence under the gitignored E2E artifact directory and attach it to the pull request rather than committing it.

## Merge and exit criteria

- All current-condition branches are pinned and fail closed.
- Run detail, ladder, compact preview, header primary, and no-move copy agree.
- A clean exact current head offers only `Adopt clean Inspector head` as the primary recovery.
- That action calls `grant-rounds`; it cannot complete the run directly.
- The daemon creates the normal immutable Inspector-only submission and completes only after current exact-head proof.
- A blocked spent Recheck is absent in the UI and refused by the daemon.
- Dirty, stale, closed, mismatched, non-live, or unavailable current evidence cannot produce the adoption label.
- Historical gate state remains visible and auditable.
- Documentation and all required checks are green.
- One reviewable pull request is opened and merged.

## Downstream handoff

There is no later phase. Future workflow UI work may rely on one shared current-condition derivation and on the existing grant route remaining the sole explicit adoption mutation. It must not turn the presentation result into browser-owned completion or bypass the Inspector ledger.

## Cross-phase audit record

- 2026-08-16: Source-plan Option A was confirmed against the current detail payload. No schema or persistence phase is needed.
- 2026-08-16: The broad `recheckInspector` acceptance was identified as a server-side truthfulness gap and added to this same vertical slice.
- 2026-08-16: One phase is sufficient at an estimated 140 to 200 non-test lines; separating server guard, presentation, or browser proof would leave an incomplete merge unit.
- 2026-08-16: Final audit confirms this phase owns every approved requirement and preserves the Shipping veto, exact-head proof, immutable audit, and one-poller boundaries.
