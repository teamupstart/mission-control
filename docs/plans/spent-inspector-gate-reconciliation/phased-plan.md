# Spent Inspector Gate Reconciliation: Phased Implementation Plan

Status: Approved for implementation

## Source of truth

- Approved product plan: `docs/plans/spent-inspector-gate-reconciliation/plan.md`
- Human decision: implement truthful state plus the existing grant path.
- Human follow-up decision: publish a merge-aware phased plan and schedule its implementation work.

The approved goal is fixed. The implementation route below reflects the current repository and may be adapted by the implementing agent when the code provides a safer or simpler route, provided the approved behavior and safety boundaries remain intact.

## Incorporated decisions

1. Keep a spent workflow run blocked and keep its Shipping veto until the operator acts.
2. Present the failed workflow observation as history and the current Inspector ledger as current truth.
3. When the exact current pull-request head is Inspector-clean, reuse `POST /api/workflow-runs/:id/grant-rounds` under the contextual label `Adopt clean Inspector head`.
4. Let the existing daemon grant and gate evaluator create the immutable `inspector_only` submission and enforce exact-head proof. The browser never completes the run itself.
5. Do not add automatic completion, a second Inspector budget, a migration, a new endpoint, or a second source of Inspector truth.

## Repository findings

- `WorkflowManager.decorateRun` already places the historical `WorkflowInspectorGateState`, the current `InspectorInspection`, and every current finding row in `WorkflowRunDetail`. The browser already receives the current reviewed and observed heads, open and resolved finding counts, review posture, and pull-request state. No wire or database change is required.
- `WorkflowManager.evaluateInspectorGate` intentionally returns early for a blocked spent run. This preserves the operator boundary. `grantRepairRounds` already raises the run-owned budget, restores an Inspector-only run to `waiting_for_new_head`, records `repair_rounds_granted`, and lets the ordinary evaluator create the audited bypass submission.
- `WorkflowManager.recheckInspector` currently accepts any non-terminal run with gate state, records a success event, and schedules evaluation. On a blocked spent run that evaluation immediately returns. The implementation must make the server refuse this dead action as well as remove it from the UI.
- `gateWaitSentence` maps the historical `waitReason` directly to current-tense copy. `WorkflowRuns`, `WorkflowLadder`, `WorkflowLadderPeek`, `runNextMove`, and `runNoMoveReason` all consume that unqualified result or the broad gate-action list.
- `runNextMove` already produces the only valid spent-run mutation, `grant-rounds`. The contextual adoption action should remain that descriptor and route, changing only its label, explanation, and current-state eligibility.
- `e2e/specs/workflow-round-limit-grant.spec.ts` already drives the real grant button and daemon route. It is the lowest-cost browser fixture to extend with an Inspector-specific spent state and current clean ledger.

## Compatibility reconciliation

The source plan described a shared browser-safe derivation, and the repository confirms that detail data is sufficient. The derivation belongs in the existing workflow presentation model rather than in `src/shared/`, because it consumes the detail-only Inspector ledger and is not a wire contract.

The source plan focused on suppressing the dead Recheck control. Repository inspection found the daemon still reports that action as successful on a blocked spent run. Phase 1 therefore narrows `recheckInspector` to states its evaluator can actually advance, preserving its existing idempotency and live-wait behavior while making direct callers truthful.

No persisted identifiers, workflow statuses, schemas, migrations, routes, SSE payloads, Inspector pollers, or Shipping rules change.

## Size estimate and phase count

Estimated non-test implementation size: **140 to 200 lines**.

Assumptions:

- 45 to 70 lines for one detail-level current-condition derivation and its copy helpers;
- 55 to 80 lines to consume it across action selection, run detail, ladder, and compact preview;
- 10 to 20 lines to narrow the existing recheck guard;
- 30 lines or fewer for scoped styling and documentation-supporting UI structure.

This is exactly one phase under the repository rubric. The server guard, shared presentation derivation, contextual action, and browser proof form one coherent vertical slice. Splitting them would merge either truthful copy without recovery or recovery without consistent copy.

## Phase table

| Phase | Outcome | Direct prerequisites | Merge unit |
|---|---|---|---|
| 1. Truthful spent-gate recovery | Historical and current Inspector state are distinguished everywhere, and a clean exact head exposes the existing audited adoption path while dead recheck requests are refused. | This planning PR | One Mission Control pull request |

## Dependency graph and merge order

```text
Planning PR publishes approved artifacts
  -> Phase 1: Truthful spent-gate recovery
```

There is no concurrency group because there is one implementation phase. Phase 1 starts only after this planning pull request merges so every path in its task brief exists on the default branch.

## Cross-phase contracts

- The durable spent state and Shipping veto remain unchanged until an explicit operator grant or cancellation.
- The Inspector ledger remains the only current pull-request truth; the workflow gate snapshot remains historical audit.
- `grant-rounds` remains the only adoption mutation. Its compare-and-swap, budget clamp, audit event, and `inspector_only` exact-head evaluator path remain authoritative.
- The browser may derive presentation and action labels, but it may not mark a gate clean or complete a run.
- Current-head cleanliness must fail closed for a missing gate, missing inspection, closed or non-open observation, unreviewed or mismatched head, non-live review posture, any open finding, or inconsistent historical fingerprint state.
- UI changes require accessible selectors, focused rendering tests, and Playwright coverage. No `data-testid` is introduced.

## Final verification strategy

Phase 1 owns all verification because it is the only merge unit:

- focused `node:test` coverage with `test/setup-state.mjs` for the derivation, action selection, server refusal, grant audit, and exact-head completion;
- rendering coverage for run detail, ladder, and compact preview copy;
- built-dashboard Playwright coverage extending the existing round-limit grant fixture;
- `npm run typecheck`;
- `npm run lint`;
- `npm test`;
- `npm run build`;
- `npm run test:e2e` after the successful build;
- `npm run smoke` because the built runtime surface changes.

## Final cross-phase audit

- Every approved requirement is owned by Phase 1.
- Every affected consumer reads one detail-level derivation rather than creating its own current-state rule.
- The existing daemon route and evaluator remain the only mutation and completion owners.
- No later cleanup phase is required to make the repository operable or the UI truthful.
- The single scheduled task will depend directly on this planning session so it cannot start before these artifacts merge.
