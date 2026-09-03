# Phase 3: Outcome analytics

## Outcome

Operators can tell whether criterion-mapped preflight improves the first Test Evidence Auditor attempt without confusing intercepted packets with accepted packets. The existing Test evidence readiness Settings card reports preflight interceptions, same-round refinements, overrides, unavailable evaluations, and Auditor disagreement by workflow version and guidance digest.

## Repository references

This phase is grounded in:

- [`plan.md`](plan.md)
- [`phased-plan.md`](phased-plan.md)
- [`phase-1-coverage-foundation.md`](phase-1-coverage-foundation.md)
- [`phase-2-enforced-preflight.md`](phase-2-enforced-preflight.md)
- [`../../reports/test-evidence-auditor-first-pass/report.html`](../../reports/test-evidence-auditor-first-pass/report.html)
- `AGENTS.md`
- `docs/workflows.md`
- `docs/agent-guides/change-contracts.md`

The merged Phase 2 result supplies the implementation base. Its final event and status names take precedence over the proposed names here.

## Entry criteria and dependencies

- Direct dependency: Phase 2 is merged.
- Phase 1 and the planning PR are transitive dependencies.
- Work only in the Mission Control repository.
- Phase 2's lifecycle events, override records, and refinement lineage are authoritative inputs.

## Scope

1. Add an explicit first-Auditor-attempt fact that remains correct after preflight refinement segments.
2. Aggregate preflight interceptions, gap classes, refinements, overrides, unavailable evaluations, and later Auditor outcomes.
3. Distinguish preflight readiness from semantic acceptance in every denominator and label.
4. Extend the existing Test evidence readiness Settings card with the new metrics and slices.
5. Add focused compatibility, aggregation, rendering, and browser coverage.
6. Finish operator documentation for interpreting and tuning the feature.

## Non-goals

- Do not change gating, repair, delivery, override, proof-role, or classification behavior.
- Do not tune Test Evidence Auditor guidance based on the first observed sample.
- Do not store criterion text, evidence captions, paths, prompt text, diff content, verdict prose, or override reasons in telemetry.
- Do not add a second analytics endpoint or Settings card.
- Do not redefine historical `firstSubmission`; preserve it for compatibility.
- Do not present a preflight interception as a pass.

## Repository findings

### Existing bounded audit event

`src/server/workflows/test-evidence-audit.ts` writes `test_evidence_audit` events containing counts, enums, workflow version, guidance identity, round, segment, and verdict outcome. It intentionally excludes content. Preserve that boundary.

### Existing denominator

The current event defines `firstSubmission` as round 1 and segment 0, and the aggregate uses that field for first-pass acceptance and evidence adoption. After Phase 2, a run can have several same-round preflight segments before its first Auditor attempt, so that field remains historical identity rather than the primary success denominator.

### Existing operator surface

`src/web/components/TestEvidenceReadinessCard.tsx`, loaded by `useWorkflowSettings.ts` and `WorkflowSettingsPanel.tsx`, already displays the audit aggregate from `/api/workflows/test-evidence-audit`. Extend that path and component instead of creating a parallel dashboard.

## Measurement contracts

### First Auditor attempt

Add `firstAuditorAttempt` to new audit records. Compute it from durable run history, not from `(round, segment)`:

- True only when no earlier completed Test Evidence Auditor attempt exists for the run.
- Retried infrastructure attempts for the same node execution do not become separate semantic Auditor attempts.
- A preflight-held segment with zero node attempts produces no audit record.
- A later same-round segment can be the first Auditor attempt.
- Inspector-only submissions and workflows without Test Evidence Auditor contribute nothing.

Prefer a store query or an explicit attempt ordinal available at event-write time. Do not infer from event scan order, because retention and malformed rows can remove earlier telemetry without removing durable attempts.

Keep `firstSubmission` unchanged on new and historical records. Lenient readers default absent `firstAuditorAttempt` to an unknown legacy state rather than false.

### Preflight lifecycle event

Aggregate bounded Phase 2 events or add one bounded `evidence_readiness_evaluated` event per captured submission containing only:

- A stable opaque submission correlation key shared with the corresponding audit event. Generate or derive it once from submission identity using the repository's bounded telemetry convention; do not expose an internal row ID.
- The stable deterministic event ID introduced at the Phase 2 persistence boundary. Re-emission of the same semantic lifecycle transition must retain the same ID.
- Policy and evaluator version.
- Readiness state.
- Round and segment.
- Refinement reason present or absent.
- Count of canonical criteria, mapped claims, warnings, and gaps.
- Gap codes, proof classes, and missing roles as bounded enums/counts.
- Override present or absent.
- Workflow ID/version and repository-scope category, without paths.

If Phase 2 already emits equivalent bounded events, consume them. Do not duplicate persisted truth solely for analytics.

### Rates and denominators

Expose at least:

| Metric | Numerator | Denominator |
| --- | --- | --- |
| First Auditor attempt accepted | Passing first Auditor attempts | All first Auditor attempts |
| Preflight interception | Enforced evaluations entering gaps wait | All enforceable readiness evaluations |
| Same-round refinement | Waiting runs that create an evidence-refinement child | Intercepted runs |
| Override | Waiting submissions activated by override | Intercepted runs |
| Readiness unavailable | Unavailable evaluations | All evaluations under the enforcing policy |
| Post-ready Auditor rejection | Failing first Auditor attempts whose activated submission was ready | First Auditor attempts whose submission was ready |
| Post-override Auditor rejection | Failing first Auditor attempts whose activated submission was overridden | First Auditor attempts whose submission was overridden |

Gap categories overlap where one submission is missing several roles. Label count and denominator precisely.

### Slicing

Retain workflow ID/version and Persona guidance digest slicing. Add readiness evaluator version where useful. Do not split by raw criterion, repository path, session, task, or evidence caption.

Historical records remain visible:

- Existing first-submission acceptance keeps its legacy label or moves into a clearly named historical row.
- First-Auditor acceptance shows `No data` for legacy-only windows rather than treating absent fields as failures.
- Malformed and truncated-window counts remain explicit.

## Server implementation

### Event writer

Extend `testEvidenceAuditEvent` inputs with the store-derived first-attempt fact, the activated submission's readiness state, and the same opaque submission correlation key used by its readiness event. It must also derive the stable deterministic event ID required by the shared workflow-event write contract. Keep the pure event construction content-free and bounded.

If first-attempt determination belongs in the engine or manager, pass a boolean into the writer. Do not make the pure formatter open the database.

The Phase 2 event persistence migration remains the single uniqueness boundary. `appendEvent` returns the existing row only when a replayed ID has the same event kind, owner, and bounded payload; it rejects mismatched reuse. Do not add aggregate-only deduplication as a substitute for storage idempotency.

### Aggregate

Extend the lenient audit schema with optional new fields, then update `aggregateTestEvidenceAudit` to:

- Track known and unknown first-Auditor records separately.
- Join or fold readiness lifecycle events by the opaque submission correlation key without retaining content or raw run/submission IDs.
- Deduplicate replayed/idempotent lifecycle events by stable event ID before computing counts or rates.
- Preserve the 2,000-event scan cap and report truncation.
- Keep category arrays deduplicated per event.
- Return zero counts with null rates when denominators are empty.

If joining two event kinds within the capped window can produce misleading partial joins, extend the store query to fetch the bounded readiness facts by referenced submission ID or persist the minimum readiness enum in the audit event itself. Prefer the design that keeps the aggregate deterministic under retention.

### Shared API

Extend `TestEvidenceAuditAggregate` and slice types additively in `src/shared/workflow.ts`. Preserve old fields consumed by current UI and tests. Keep the existing endpoint and limit validation.

## Dashboard implementation

Extend `TestEvidenceReadinessCard` rather than creating another card:

- Lead with `First Auditor attempt accepted`.
- Show the legacy first-submission metric with an explicit historical label when useful.
- Show interceptions, refinements, overrides, unavailable evaluations, post-ready rejection, and post-override rejection.
- List the most frequent missing proof classes and roles with overlapping-count disclosure.
- Retain workflow-version and guidance-digest slices.
- Explain `No data`, malformed records, and truncated windows.
- State that readiness is structural and Test Evidence Auditor remains semantic.

Keep the card compact and accessible. Use the established Settings matrix/card visual language and semantic labels. Add no `data-testid`.

## Files and components expected to change

- `src/shared/workflow.ts`
- `src/server/workflows/test-evidence-audit.ts`
- `src/server/workflows/store.ts` or the engine/manager call site that determines first attempt
- `src/server/workflows/engine.ts` if it owns audit event creation
- `src/server/routes.ts` only if response wiring needs an additive change
- `src/web/components/TestEvidenceReadinessCard.tsx`
- `src/web/useWorkflowSettings.ts` only if the response shape or loading behavior changes
- `src/web/lib/settings-search.ts` for new searchable labels
- Existing audit, workflow engine, Settings rendering, and E2E tests
- `docs/workflows.md` and related operator guidance

Do not edit generated files or unrelated Settings surfaces.

## Tests

### Event and aggregate tests

- A first Auditor attempt on round 1, segment 2 is counted as first.
- A second Auditor attempt in a later repair round is not first.
- Infrastructure retries do not create extra semantic first attempts.
- A held preflight segment contributes to interception but not Auditor acceptance.
- Ready, overridden, unavailable, and policy-off outcomes use correct denominators.
- Post-ready and post-override rejection rates are distinct.
- Overlapping gap categories cannot exceed their own denominator semantics unexpectedly.
- Legacy events without new fields remain readable and do not become false failures.
- Replayed lifecycle events are deduplicated.
- Calling the audit writer and persistence path twice for one semantic attempt produces one stored event; the same event ID with different bounded content is rejected.
- Readiness and Auditor events join only through the stable opaque submission correlation key, and raw run/submission IDs are absent.
- Re-emitting one semantic lifecycle transition preserves its event ID while a distinct transition receives a distinct ID.
- Empty, malformed, and scan-truncated windows remain honest.
- Workflow version, guidance digest, and evaluator version slices sort deterministically.

### Rendering tests

- `No data` appears when no first-Auditor records exist.
- The card never labels an interception as accepted.
- All rates display numerator and denominator.
- Legacy first-submission and new first-Auditor labels cannot be confused.
- Missing proof-role counts disclose overlap.
- Truncation and malformed-record warnings remain visible.

### Browser E2E

Extend the focused evidence-readiness Playwright scenario or add a narrowly scoped Settings scenario that seeds bounded audit/readiness events and verifies:

- First Auditor attempt acceptance is the headline.
- Interceptions and overrides are separate counts.
- Post-ready rejection is visible.
- Workflow version and guidance digest identify the slice.
- No criterion or evidence content leaks into the card.

Capture the completed card at desktop and its constrained-width layout if the component changes responsively.

## Verification commands

Choose final focused files based on implementation. At minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/workflow-test-evidence-audit.test.ts test/workflow-runs-render.test.ts test/workflow-engine.test.ts
npm run typecheck
npm run lint
MISSION_TEST_CONCURRENCY=8 npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/workflow-evidence-readiness.spec.ts
```

Register exact focused command output and the rendered Settings card through Mission Control.

## Documentation

Update operator documentation to explain:

- Workflow context is an existing configurable model job.
- Model proof-class suggestions are advisory.
- Preflight completeness is not Auditor acceptance.
- First Auditor attempt differs from first submission.
- The meaning and denominator of every displayed rate.
- How post-ready rejection identifies matrix blind spots without automatically changing policy.

## Merge and exit criteria

- First Auditor attempt is derived from durable attempt history and remains correct across same-round segments.
- Interceptions never enter the acceptance denominator.
- Legacy events remain readable and visibly distinct.
- Readiness metrics contain only bounded counts, enums, identifiers, timestamps, and digests.
- Existing endpoint and Settings card own the expanded surface.
- The dashboard clearly separates structural readiness from semantic Auditor judgment.
- Focused, full, build, smoke, and browser verification pass.
- Documentation matches the final implementation and denominators.

## Downstream handoff

This is the final planned phase. Later tuning may rely on the new metrics, but it must be commissioned separately. Do not automatically change proof-role rules or Test Evidence Auditor guidance based on an early sample.

## Cross-phase audit record

- 2026-09-03: Preserved the historical `firstSubmission` field and added a separate first-Auditor fact rather than changing old event meaning.
- 2026-09-03: Required durable attempt history for first-attempt identity so event retention cannot rewrite the denominator.
- 2026-09-03: Reused the existing audit endpoint and Settings card to avoid a second analytics source.
- 2026-09-03: Kept content-bearing fields out of telemetry and assigned all behavior changes to Phase 2.
