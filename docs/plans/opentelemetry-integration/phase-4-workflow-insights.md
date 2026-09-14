# Phase 4: workflow stages, persona verdicts and recovery

## Outcome and value

Show which workflows/stages run, how personas accept or reject work, why they request changes, and when a human must recover a workflow. Keep actual reviews, response errors, reused passes and feedback delivery distinct, with reviewer and author model/effort context.

Read [the source plan](plan.md), [the index](phased-plan.md), [P3](p3-workflow-insights/plan.md), P0's contract and Phase 3's session handoff. This guide proposes the route; adapt to current owners and record justified deviations in the PR.

## Entry, dependencies and scope

Direct prerequisite: Phase 3 merged, plus the planning PR. Repository: Mission Control only. Effective context, operation identity, profile controls and durable capture must already be operable.

Own definition/binding/run/submission/stage/node/attempt/review/repair/delivery/intervention telemetry and the corresponding workflow/persona actions. Add bounded general reason classification through the existing persona protocol while retaining unknown/provenance. Freeze contracts required by parallel Phases 5/6. Other feature navigation/automation/errors belong to Phase 5; cross-run analytics to Phase 6; dashboards to Phase 7. Do not change workflow verdict meaning, graph execution, evidence policy or repair budget to improve telemetry.

## Repository evidence and compatibility

`src/shared/workflow-stages.ts` projects stages from immutable graph identity; `src/shared/workflow-lifecycle.ts` decodes state/phase/gate. `src/shared/workflow.ts` distinguishes node attempts, model/runner and finding basis. The engine skips disabled nodes, reuses prior passes and validates model responses before recording semantic verdicts.

`src/server/workflows/store.ts` owns attempts/receipts/events and transaction boundaries. `finishAttemptWithReceipts` is stronger completion evidence than a later advisory `persona_verdict` event. Some events have an idempotent event ID, others do not. `src/server/workflows/manager.ts` owns repairs and delivery. Current `16369e60` increases first-round evidence retries; preserve this behavior and test it with `test/workflow-evidence-preflight.test.ts`.

## Implementation sequence

1. Map each P3 source event to its authoritative method, durable identity/revision, actual timing boundary and recovery window. Reuse Phase 3's author context at submission and actor/operation identity. Record reviewer execution model independently; persist resolved effort at the execution seam when available, otherwise export unknown.
2. Instrument run/binding/submission changes and stage occurrences through existing graph/lifecycle projections. Record eligibility/queue/execution/wait only when observed. Parallel stage wall time is not summed persona duration; blocked state is not proof of human waiting or terminal failure.
3. Capture actual node attempts and response validity separately from semantic pass/fail and executed/reused/disabled/cancelled disposition. Use durable attempt/receipt completion as the dedupe authority; advisory broadcasts/events cannot cause another contribution. Late results after cancellation remain distinct.
4. Extend structured finding normalization with the bounded general reason taxonomy, independent of existing `substantive`, `coverage_registration` and `evidence_access` bases. Optional invalid/missing categories become unknown, never a new work rejection or extra model retry. Change maintained persona/schema sources and regenerate outputs through the existing scripts when necessary; do not edit generated artifacts or add paid classification calls.
5. Observe repair packet preparation/delivery/pickup/resubmission at manager/store boundaries. Many reviewer findings may produce one packet. Preserve all causal links, but count verdicts, findings, packets and repair rounds at their own grains. Uncertain delivery and later resolution retain stable identity.
6. Instrument manual resume/retry/restart, budget grants, directive changes, enable/disable, readiness override, recheck, cancel and authored approvals once at their owners. Classify required decision/recovery/steering/termination/unknown using action-time state and actor basis. Automatic/Foreman actions never count as confirmed human recovery.
7. Reconcile post-restart durable outcomes within source retention/cutover bounds. Freeze context required for replay instead of rereading current model/graph/persona settings. Record genuinely unrecoverable gaps rather than inventing stage pickup timestamps.
8. Freeze the common source schemas and separate source/projection registration write sets before the Phase 5/6 fork. The standard action-result envelope must already represent feature, operation, actor basis, outcome/time and coverage for repeat-use reducers. The bounded versioned projection-state API must support the cohort reducer without another common DB migration. Record ownership and examples in technical docs.

## Data, API and compatibility

Add explicit actual-review effort/context fields only at the owner and migration path when the runtime supplies them. Preserve append-only enum identities and upgrade behavior. Use the Phase 1 store for telemetry snapshots/checkpoints, not a duplicate workflow history table or a second stage graph.

Keep source transactions independent from telemetry failures. If source reconciliation is used to close post-commit gaps, record its source identity and immutable metadata requirements. Changes to structured persona categories are backward compatible and telemetry-advisory; old custom personas remain valid.

Freeze event/metric predicates for executed rejection, invalid response, reused result, delivered packet, repair round and successful recovery before consumers. Raw requested-change text, file paths and PR URLs never enter outbound facts.

## Tests and verification

Add the shared P3 golden fixture: reviewer A malformed response then fail, B pass, one delivered repair, one human resubmit, A pass/B reused. Assert 3 executed reviews, 2 passes, 1 fail, 4 provider executions, 1 invalid response, 1 reuse, 1 packet, 1 repair round and 1 recovery action. Persist/restart/replay without changing totals.

Cover disabled-before-claim and disabled-during-run, directive preventing reuse, explicit recheck, same persona twice, multi-stage/parallel execution, missing stage projection, cancelled late result, evidence retry budget, uncertain delivery and actor ambiguity. Use root `AGENTS.md` for focused `test/workflow-engine.test.ts`, `test/workflow-verdict.test.ts`, `test/workflow-stages.test.ts`, `test/workflow-run-lifecycle.test.ts` and relevant evidence tests.

Run `npm run typecheck`, `npm run lint`, `npm run build` and `npm run smoke`. Add focused fake-agent Playwright workflow/resume/persona-control flows for changed browser request behavior or UI. Inspect metrics and searchable traces through the isolated local stack; test both audience allowlists and category compatibility. Do not rerun a passed review workflow merely to repair Inspector feedback.

## Merge, exit and downstream handoff

Exit with correct golden totals, source-owned stage/review/repair observations, current evidence behavior preserved, unknown actor/reason coverage, restart safety and passing scoped checks. The new telemetry must not change whether a workflow passes, fails, retries or terminates.

Phase 5 inherits the already-instrumented workflow/persona action map and source registry. It adds other action families and safe error ingress. Phase 6 consumes immutable run/review/repair/intervention facts and registers reducers in its own projection subtree. Document that Phase 5 does not edit analytical reducers/migrations and Phase 6 does not edit route/action/worker owners, browser state or source definitions; either may merge first.

Open a reviewable phase PR and meet current review/CI requirements. Its merge releases both Phases 5 and 6. Missing common contracts must be resolved before that release rather than patched incompatibly by the two consumers.

## Cross-phase audit

2026-09-13: re-read source/index and Phases 1-3. Reviewer context extends Phase 3 rather than replacing author context. Semantic verdicts are not provider failures; current evidence retries stay separate. The source/projection extension contract is completed here before the fork, preserving the claimed independent write sets of Phases 5/6. No common migration is deferred to either parallel consumer.
