# Phase 2: Enforced preflight

## Outcome

Workflow versions using `criterion_mapped_v1` pause structurally incomplete evidence before any Persona attempt. The session receives one exact, repository-scoped repair packet. New evidence produces an immutable child segment in the same repair round, while an operator can continue the original immutable packet through an audited override. A new No-Mistakes Review version opts into this behavior.

## Source requirements

Read before implementation:

- [`plan.md`](plan.md)
- [`phased-plan.md`](phased-plan.md)
- [`phase-1-coverage-foundation.md`](phase-1-coverage-foundation.md)
- `AGENTS.md`
- `docs/agent-guides/architecture.md`
- `docs/agent-guides/change-contracts.md`
- `docs/workflows.md`
- `e2e/README.md`

The Phase 1 pull request must already be merged. Confirm its final names and APIs before implementing this proposed route, and record justified deviations in the Phase 2 pull request.

## Entry criteria and dependencies

- Direct dependency: Phase 1 is merged.
- The planning PR is an indirect dependency through Phase 1.
- Work only in the Mission Control repository.
- Phase 1's persisted IDs, coverage identity, advisory classification rule, and atomic capture are fixed inputs.

## Scope

1. Add the evidence-readiness wait state, delivery kind, refinement reason, and audited override persistence.
2. Gate `criterion_mapped_v1` submissions after capture and before Persona activation.
3. Deliver exact structural gaps without spending Persona attempts.
4. Resume from new evidence through a same-round child segment.
5. Preserve SessionAction continuation ordering and lineage.
6. Support operator override of the same immutable submission.
7. Implement independent multi-repository gating with serialized session delivery.
8. Publish a new No-Mistakes Review version that opts into enforcement.
9. Expose the now-supported draft policy in workflow properties and expose waiting, repair, lineage, and override state in the built dashboard.

## Non-goals

- Do not change proof classes, proof roles, gap meanings, or model authority from Phase 1.
- Do not treat a ready or overridden packet as Auditor acceptance.
- Do not change Persona repair-round limits.
- Do not import PR comments, CI checks, or Inspector evidence.
- Do not add automatic command execution or screenshot capture.
- Do not rewrite No-Mistakes Review versions 1 through 11.
- Do not implement aggregate success analytics; Phase 3 owns that surface.

## Inherited contracts

- `off` permits advisory evaluation but never pauses activation.
- `criterion_mapped_v1` enforces deterministic structural gaps.
- Model-only proof-class disagreement remains a warning.
- Compaction/readiness `unavailable` remains fail-open.
- `parent_submission_id` is the only submission lineage relation.
- Coverage links resolve against evidence frozen in the same submission and repository scope.
- Every delivery into one session is serialized through the existing queue.

## Lifecycle contracts

### Append-only values

Append, without renaming or reordering existing values:

- `waiting_for_evidence_readiness` to run and submission statuses.
- `evidence_readiness` to delivery kinds.
- `evidence_preflight` to a new submission refinement-reason enum.
- `overridden` to readiness status if Phase 1 did not already reserve it.

Add exhaustive labels, state predicates, serializers, strict parsers, event projections, export readers, and browser mappings at the same time.

### Blocking decision

After context compaction and deterministic readiness evaluation:

- `ready`: proceed to activation.
- `unavailable`: record the fail-open reason and proceed to activation.
- `gaps` with policy `off`: proceed to activation with advisory gaps.
- `gaps` with policy `criterion_mapped_v1`: persist both run and submission as `waiting_for_evidence_readiness`, append a bounded event, publish run state, and schedule one readiness delivery.
- Null readiness with policy `criterion_mapped_v1`: synthesize a deterministic `missing_coverage` gap, persist the result, and follow the same waiting path. Null is never an activation-ready result for an enforcing policy.
- `overridden`: proceed to activation with the override record visible.

Do not create queued node attempts until activation. A blocked preflight therefore has zero Persona or Check attempts.

### Activation ordering

Refactor `captureAndActivate` only as far as necessary to make its activation gates explicit and testable:

1. Capture and freeze evidence and coverage.
2. Persist raw context.
3. Run Workflow context compaction.
4. Persist fingerprints and readiness result.
5. Run the existing caller-supplied `beforeActivate` guard.
6. If the guard succeeds, commit its effects.
7. Apply evidence-readiness enforcement.
8. Activate the graph only when all guards permit it.

The SessionAction callback must run before readiness enforcement. A successful action expectation may seed carried receipts and close its attempt even when the new child segment then waits for missing evidence. A failed action guard remains a conflict and must not create a readiness delivery.

### Readiness delivery

Render one bounded `evidence_readiness` packet containing:

- Repository identity.
- Round and segment.
- Canonical criterion text.
- Author-declared proof class.
- Evidence already linked by role.
- Stable gap codes translated into specific missing actions.
- The existing evidence registration authorization and `submit_workflow_evidence` instructions.
- A reminder that model class suggestions are advisory.

The packet must never include internal row IDs, absolute paths, artifact bodies, compactor prompt text, or evidence from a sibling repository.

Use the existing prepared/sending/delivered/refused/uncertain/cancelled delivery lifecycle. Preserve one outstanding delivery per session, confirmation idempotency, restart recovery, uncertain-send handling, and queue ordering.

## Same-round evidence refinement

### Reservation

Add a store method dedicated to evidence refinement. In one transaction it:

1. Verifies the run and latest submission still wait for readiness.
2. Verifies fresh evidence generation for that repository or an explicit operator retry request.
3. Reserves `(run_id, same round, segment + 1)`.
4. Sets `parent_submission_id` to the waiting segment.
5. Sets `refinement_reason` to `evidence_preflight`.
6. Leaves continuation-node fields null.
7. Reserves the current applicable evidence and coverage group.
8. Moves the run into capture without incrementing the Persona repair round.

The operation is idempotent by trigger/request key and refuses competing refinements rather than creating sibling segments. Resolve an existing trigger/request key before checking mutable run or submission state. Return its existing refinement only when the target run, waiting submission, repository scope, requested generation, and manual retry intent match; reject key reuse with a different payload. Only a new key proceeds to current-state validation and reservation.

### Resumption observer

Extend automatic evidence-change observation with a distinct readiness path. Do not add `waiting_for_evidence_readiness` to generic Persona repair predicates.

The observer must:

- Compare the waiting submission's repository-scoped staged generation to the current generation.
- Ignore unrelated sibling-repository changes.
- Create at most one child segment per newly observed generation.
- Respect active capture and outstanding-delivery guards.
- Recover after daemon restart.
- Stop observing terminal, cancelled, superseded, and overridden submissions.

Manual dashboard retry calls the same reservation method and uses a request ID.

### Unchanged evidence

The existing unchanged-evidence nudge counts Persona repair submissions. Do not reuse its refusal budget for preflight refinements. If the author resubmits without a new generation, retain the waiting segment and return a typed no-change response. An operator may still choose override.

## Operator override

### Persistence

Add `workflow_submission_readiness_overrides` as an append-only table with:

- Override ID.
- Submission ID.
- Request ID with an idempotency constraint.
- Actor or authenticated operator provenance supported by the current local control plane.
- Bounded non-empty reason.
- Creation time.

An override does not mutate frozen coverage, evidence, canonical criteria, or gaps. The projected readiness state may be `overridden`, but the original evaluation remains readable.

### API

Add an authenticated dashboard route equivalent to:

```text
POST /api/workflow-runs/:runId/submissions/:submissionId/evidence-readiness/override
```

The body contains `requestId` and `reason`. Resolve `requestId` before validating mutable workflow state. Return the existing override when its run, submission, and normalized reason match exactly; reject reuse with a different target or reason. Only a new request verifies run/submission ownership, pinned policy, current waiting state, latest-segment identity, and nonterminal binding before recording the override and activating that exact submission.

Do not expose override through the agent MCP tool. It is an operator exception, not an author evidence claim.

### Dashboard

In run detail:

- Label the run `Waiting for evidence readiness`.
- Explain each unresolved deterministic gap.
- Show linked evidence, model warnings, and same-round lineage.
- Offer `Continue despite gaps` only on the current waiting submission.
- Require a non-empty reason and explicit confirmation that Test Evidence Auditor may still reject the packet.
- Disable duplicate actions while the request is in flight.
- Keep the original gaps visible after override.

## Multi-repository behavior

Evaluate and transition each repository run separately. An `all` claim is applicable only when its linked evidence is also applicable to that run. Ready siblings may activate while incomplete siblings wait.

Delivery remains session-serialized:

- Prepare one packet per waiting run.
- Queue packets through the existing delivery owner.
- Include repository identity in the title and body.
- A repair for repository A must not advance repository B's staged generation or segment.
- An operator override targets one exact run/submission pair.

Add coverage for two siblings where one activates, one waits, and their queued packets and later refinements remain isolated.

## Built-in workflow opt-in

Lift Phase 1's publish guard for `criterion_mapped_v1` only after the enforcing lifecycle exists, and expose Off or Criterion mapped in workflow properties. Publishing freezes the chosen policy into the immutable version; create and duplicate still default to `off`.

Append No-Mistakes Review version 12 in `src/server/workflows/builtin-workflows.ts` using the version 11 graph, completion policy, resumption policy, and binding defaults, with `evidenceReadinessPolicy: "criterion_mapped_v1"` as the only behavioral addition unless the then-current default branch has published another version.

If another version lands first, append the next available immutable version and document the actual version number. Never rewrite prior literals. Update duplicate seeds and version-history copy from the final current version.

## Server and UI areas expected to change

- `src/shared/workflow.ts`
- `src/shared/protocol.ts`
- `src/server/db.ts`
- `src/server/workflows/store.ts`
- `src/server/workflows/manager.ts`
- `src/server/workflows/engine.ts` only if activation needs a narrow explicit boundary
- `src/server/workflows/feedback.ts`
- `src/server/workflows/agent-contract.ts`
- `src/server/workflows/builtin-workflows.ts`
- `src/server/routes.ts`
- `src/web/workflows/run-model.ts`
- `src/web/workflows/WorkflowProperties.tsx`
- `src/web/workflows/WorkflowRuns.tsx`
- `src/web/lib/api.ts`
- `src/web/styles.css`
- Existing workflow status, delivery, resumption, SessionAction, multi-repository, and E2E tests
- `docs/workflows.md`, `docs/agent-guides/architecture.md`, and `docs/agent-guides/change-contracts.md`

Follow actual ownership on the merged Phase 1 base and avoid unrelated edits.

## Tests

### State-machine tests

- Policy off plus gaps activates normally.
- Policy on plus ready activates exactly once.
- Policy on plus unavailable activates exactly once.
- Policy on plus gaps reaches the readiness wait state with zero node attempts.
- Policy on plus absent coverage synthesizes `missing_coverage` and reaches the readiness wait state with zero node attempts.
- Restart preserves the wait and recreates no duplicate delivery.
- Delivery confirmation, refusal, uncertain send, retry, cancellation, and queue order use existing semantics.
- A new applicable generation reserves one same-round child segment.
- Unchanged or unrelated-repository evidence reserves nothing.
- Concurrent automatic and manual retry create one child.
- Persona repair rounds remain unchanged.
- SessionAction completion commits before its child segment pauses, while a failed action expectation produces no readiness wait.

### Override tests

- Empty and oversized reasons fail validation.
- Wrong run/submission, historical segment, terminal run, and policy-off submission are refused.
- Replayed request ID returns the existing override and activates once.
- Override activates the same immutable submission without changing evidence or gaps.
- Agent MCP cannot invoke override.
- Restart after override does not return the run to readiness wait.
- Replaying an override or manual refinement after state changes returns the prior result only for an identical target and payload; mismatched key reuse conflicts.

### Multi-repository tests

- Ready and incomplete siblings diverge correctly.
- `all` claims and evidence apply consistently.
- Scoped evidence updates only the intended sibling.
- Delivery serialization names the correct repository and eventually drains both packets.
- Override and refinement target one run without mutating the other.

### Browser E2E

Extend `e2e/specs/workflow-evidence-readiness.spec.ts` against the built dashboard:

1. Bind or submit through the opted-in built-in workflow.
2. Declare a visual claim with browser output but no rendered evidence.
3. Verify the run pauses before any Persona attempt and names `Rendered output` as missing.
4. Register and link a screenshot.
5. Verify a child segment appears in the same round and the workflow activates.
6. Exercise a separate waiting run through `Continue despite gaps`, require a reason, and verify its unresolved gap remains visible after activation.
7. Capture screenshots for the waiting, repaired, and overridden states.

Fake every agent binary. Select by role, label, or placeholder and never add `data-testid`.

## Verification commands

Choose focused files from the final implementation. At minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/workflow-repair-cycle.test.ts test/workflow-resumption.test.ts test/workflow-delivery.test.ts test/session-action-durability.test.ts test/workflow-image-evidence.test.ts
npm run typecheck
npm run lint
MISSION_TEST_CONCURRENCY=8 npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/workflow-evidence-readiness.spec.ts
```

Register the exact focused output and the three rendered browser states through Mission Control after the final run.

## Merge and exit criteria

- `criterion_mapped_v1` gaps pause before graph activation and create zero node attempts.
- Ready, unavailable, policy-off, and overridden submissions activate exactly once.
- Same-round child segments preserve immutable evidence and Persona repair budget.
- SessionAction continuation remains correct under both ready and waiting child captures.
- Operator override is durable, idempotent, reasoned, and unavailable to agents.
- Multi-repository siblings remain isolated while delivery stays serialized.
- A new immutable No-Mistakes Review version opts in without changing earlier versions.
- Run detail and browser E2E demonstrate waiting, repair, and override behavior.
- Focused, full, build, smoke, and E2E checks pass.

## Downstream handoff

Phase 3 may rely on:

- Final readiness events and states.
- Explicit refinement reason and parent lineage.
- Durable override records.
- A new built-in workflow version actively producing preflight outcomes.
- Zero-attempt waiting as a real distinction from Auditor rejection.

Phase 3 must not infer first Auditor attempt from round/segment, weaken enforcement, mutate readiness history, or add content-bearing telemetry.

## Cross-phase audit record

- 2026-09-03: Preserved all Phase 1 IDs and moved only enforcement lifecycle into this phase.
- 2026-09-03: Ordered SessionAction guard completion before readiness enforcement so an action cannot be stranded.
- 2026-09-03: Kept override in the same phase as enforcement so every newly blocking state ships with an operator escape path.
- 2026-09-03: Made this phase responsible for lifting Phase 1's non-off publish guard and exposing the policy choice only after enforcement exists.
- 2026-09-03: Updated the opt-in target to version 12 after current main shipped Code Design Reviewer in version 11; earlier literals remain unchanged.
- 2026-09-03: Assigned aggregate measurement to Phase 3 to keep this state-machine pull request reviewable.
