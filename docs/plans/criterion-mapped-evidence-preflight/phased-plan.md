# Criterion-mapped evidence preflight: phased implementation plan

## Source of truth

- Approved goal: [`plan.md`](plan.md)
- Supporting rejection analysis: [`../../reports/test-evidence-auditor-first-pass/report.html`](../../reports/test-evidence-auditor-first-pass/report.html)
- Repository: `teamupstart/mission-control`
- Planning decision: the operator explicitly requested a phased implementation plan and scheduling on 2026-09-03, superseding the earlier choice to stop after the root plan.

## Incorporated human decisions

1. Lead with criterion-mapped evidence readiness rather than changing Test Evidence Auditor standards.
2. Reuse the existing configurable `workflow-context` background job. Do not add a model or Settings row.
3. Extend that job with bounded changed-path, clipped diff-summary, evidence-caption, and claim metadata.
4. The author's proof-class declaration selects hard evidence-role requirements. Model-only proof-class suggestions warn and never independently demand a screenshot.
5. Keep Test Evidence Auditor as the semantic authority.
6. Schedule implementation as durable, dependency-linked Mission Control tasks.

## Repository findings and resolved discrepancies

### Existing model job, narrower current prompt

`src/server/workflows/context.ts` already runs `workflow-context` as a tool-less, structured, 45-second app-owned call and records the resolved runner and model. Its current prompt includes only the raw goal, refined goal, and human decisions even though `RawWorkflowContext` also carries diff and evidence. Phase 1 extends this existing call and schema rather than creating another model job.

### Evidence has one owner despite the filename

`src/server/workflows/images.ts` stages, captures, and finalizes both image and text evidence. `workflow_evidence_staging` is the mutable source, while submission image and text tables are immutable snapshots. Coverage must extend this pipeline and its atomic reservation rules, not create a parallel evidence service.

### Coverage-only staging is currently invalid

`SubmitWorkflowEvidenceSchema` requires at least one image, artifact, or command output. The new optional `coverage` array must count as a material submission so an author can declare an unsatisfied criterion and receive a precise gap before producing its proof.

### Submission lineage already exists

`workflow_submissions.parent_submission_id` and `(run_id, round, segment)` already represent SessionAction child segments. Reuse the parent column and add an append-only refinement-reason field. Do not add a second parent relation. SessionAction continuation keeps its continuation-node fields; evidence refinement leaves them null.

### The activation seam exists but ordering matters

`WorkflowManager.captureAndActivate` persists raw evidence, compacts context, computes fingerprints, runs an optional SessionAction `beforeActivate` guard, and then calls `engine.activateSubmission`. Readiness belongs in this seam. For a SessionAction child, the action-completion guard must commit first; readiness may then pause the captured child before graph activation. Reversing that order can strand a completed action in its old attempt state.

### Current resumption watches a different wait state

Automatic repair resumption intentionally filters on `waiting_for_session`. Evidence readiness needs its own wait state and observer path so it cannot be mistaken for Persona rejection or consume a repair round. The one-outstanding-delivery invariant still applies.

### Built-in versions are immutable application data

No-Mistakes Review versions 1 through 11 are declared literally in `src/server/workflows/builtin-workflows.ts`; version 11 added Code Design Reviewer after the root plan was first drafted. The readiness policy must be version-pinned and default old database rows and custom workflows to `off`. Only a new built-in version opts into enforcement.

### Existing first-submission telemetry becomes insufficient

`src/server/workflows/test-evidence-audit.ts` defines first submission as round 1, segment 0. A held packet may reach its first Auditor attempt on a later segment in the same round. Preserve the historical field and add an explicit first-Auditor-attempt dimension.

## Size estimate

Estimated non-test implementation: **3,000 to 4,700 lines** across shared contracts, migrations, evidence capture, context compaction, workflow lifecycle, delivery, browser state, UI, and telemetry.

Assumptions:

- Existing upload, evidence reservation, workflow run detail, and model-job infrastructure are extended rather than replaced.
- Generated built-in Persona output is regenerated from its source rather than hand-edited.
- Test code, fixtures, plan documents, and generated artifacts are excluded from the estimate.
- The estimate includes compatibility handling for old workflow definitions, versions, submissions, and exports.

## Why three phases

One phase would combine mutable authoring, immutable storage, model schema evolution, new wait-state concurrency, auto-resumption, operator override, a built-in workflow version, and analytics. That is too broad for one review and makes failures hard to localize.

Two phases would still leave the enforcement pull request responsible for both new lifecycle behavior and the analytics needed to determine whether that behavior improves Auditor outcomes. Separating observation from enforcement keeps the state-machine change reviewable while giving analytics its own coherent user-visible outcome.

Three phases are the smallest safe split:

1. Establish criterion coverage end to end while enforcement remains off.
2. Enforce readiness with resumable lifecycle and audited override, then opt in a new built-in version.
3. Measure first-Auditor outcomes and surface where the preflight agrees or disagrees with the Auditor.

Each phase leaves the repository valid. There are no test-only, documentation-only, or cleanup phases.

## Phase graph

```mermaid
flowchart LR
  P1[Phase 1: Coverage foundation] --> P2[Phase 2: Enforced preflight]
  P2 --> P3[Phase 3: Outcome analytics]
```

There are no concurrent implementation groups. Each phase consumes durable contracts or lifecycle behavior introduced by its predecessor.

## Phase index

| Phase | Outcome | Estimated production change | Direct prerequisite | Merge reason |
| --- | --- | ---: | --- | --- |
| [Phase 1: Coverage foundation](phase-1-coverage-foundation.md) | Authors can stage criterion claims, freeze them with evidence, and inspect deterministic readiness results while every workflow remains non-blocking. | 1,300-2,000 lines | Planning PR | Owns schemas, storage, compaction, and evidence-authoring contracts consumed later. |
| [Phase 2: Enforced preflight](phase-2-enforced-preflight.md) | Opted-in submissions pause before Personas, repair in the same round, or continue through an audited operator override. | 1,100-1,800 lines | Phase 1 | Owns state transitions, delivery, resumption, override, and built-in version activation. |
| [Phase 3: Outcome analytics](phase-3-outcome-analytics.md) | Operators can measure first Auditor attempt acceptance, interceptions, overrides, and preflight/Auditor disagreement. | 600-900 lines | Phase 2 | Owns the new measurement semantics and feedback loop without mixing them into the state-machine change. |

## Merge order

1. Merge the planning PR so every scheduled task can resolve these paths from the default branch.
2. Merge Phase 1 before Phase 2. Phase 2 must not duplicate or revise Phase 1's persisted enums, coverage IDs, or readiness result shape.
3. Merge Phase 2 before Phase 3. Phase 3 derives measurements from Phase 2's final events and lifecycle states.

## Cross-phase contracts

### Stable identifiers

- Enforcement policy: `off | criterion_mapped_v1`. Coverage supplied under `off` is still evaluated and displayed, but never pauses activation. Under `criterion_mapped_v1`, absent coverage becomes a deterministic `missing_coverage` gap; null readiness never activates.
- Idempotency: resolve replay keys and verify their immutable target/payload before mutable-state validation for refinements and overrides.
- Analytics identity: correlate readiness and Auditor events with one bounded opaque submission key. Phase 2 adds an optional stable deterministic event ID to the shared write contract and enforces non-null uniqueness at `appendEvent`; Phase 3 makes `testEvidenceAuditEvent` provide it. Never emit raw internal IDs.
- Proof classes: `focused_execution`, `integration`, `visual`, `performance`, `rendered_artifact`, `state_confirmation`.
- Proof roles: `execution`, `rendered_output`, `baseline_measurement`, `result_measurement`, `deliverable`, `state_snapshot`.
- Readiness states: `not_evaluated`, `ready`, `gaps`, `unavailable`, `overridden`.
- Enforced wait status: `waiting_for_evidence_readiness`.
- Delivery kind: `evidence_readiness`.
- Refinement reason: `evidence_preflight`.

These are append-only once Phase 1 lands. Later phases may add values only when compatibility demands it; they must not rename or reorder persisted values.

### Classification authority

- Canonical criteria are proposed by the existing `workflow-context` model call.
- Stable criterion IDs are daemon-derived from normalized text and ordinal.
- Authors declare proof classes.
- Deterministic code checks evidence identity, repository scope, and roles required by the declared class.
- Model-only class disagreements are warnings.
- Missing canonical mappings, invalid links, scope conflicts, and missing author-required roles are structural gaps.
- Compaction failure yields `unavailable` and never blocks activation.

### Evidence identity and immutability

- `clientCriterionId` is stable within a note key and used by both dashboard and MCP authoring.
- Coverage links name evidence `clientItemId` values, never internal row IDs or paths.
- Staging changes advance the existing evidence generation.
- Reservation freezes evidence and coverage together for one submission and repository scope.
- An immutable submission is never edited after capture.

### Segment lineage

- Persona rejection increments `round` under existing rules.
- Evidence-preflight correction increments `segment` within the same round.
- `parent_submission_id` names the prior immutable segment.
- The new refinement reason distinguishes evidence correction from SessionAction continuation.
- SessionAction continuation fields remain exclusive to SessionAction children.

### Multi-repository scope

- Each repository run evaluates its own frozen packet.
- `all` claims apply only where their linked evidence is also applicable.
- One sibling may activate while another waits.
- The shared session still receives one outstanding delivery at a time, with repository identity in every readiness packet.

## Final verification strategy

Each phase runs focused tests with `test/setup-state.mjs`, then typecheck and lint. Phases with runtime changes run the full unit suite, build, and smoke. Every visible dashboard change has Playwright coverage against the built application and produces gitignored screenshot evidence.

The final integrated verification after Phase 3 includes:

```sh
MISSION_TEST_CONCURRENCY=8 npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/workflow-evidence-readiness.spec.ts
```

The implementation agents must register exact focused command output and rendered UI evidence through Mission Control. Evidence artifacts remain gitignored and are not committed.

## Complete-plan compatibility audit

- Every root-plan acceptance criterion has one owning phase.
- Phase 1 owns additive contracts, storage, authoring, compaction, reconciliation, and safe fallback.
- Phase 2 owns blocking, delivery, same-round repair, multi-repository behavior, operator override, and built-in opt-in.
- Phase 3 owns first-Auditor measurement, disagreement analysis, and the operator-facing analytics surface.
- The configurable Workflow context decision is preserved without a new model job.
- No phase weakens Test Evidence Auditor or treats preflight readiness as semantic acceptance.
- The dependency graph is intentionally serial and contains no hidden cleanup phase.

## Cross-phase audit record

- 2026-09-03: Replaced the root plan's speculative new refinement-parent relation with the existing `parent_submission_id` plus a new reason field.
- 2026-09-03: Bound model-only proof-class output to warnings so it cannot independently request screenshots.
- 2026-09-03: Assigned SessionAction guard ordering to Phase 2 to preserve action completion before a readiness hold.
- 2026-09-03: Prevented Phase 1 from publishing a non-off policy before Phase 2 implements the lifecycle; Phase 2 owns lifting that guard and exposing the editor choice.
- 2026-09-03: Rebased onto current `origin/main` and updated the built-in opt-in target from version 11 to version 12 after Code Design Reviewer shipped in version 11.
- 2026-09-03: Confirmed all implementation remains in the Mission Control repository.
