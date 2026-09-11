# Recover from workflow criterion mapping failures

Scope: review comment MC-8575.1, finding 1 of the workflow evidence completion audit. Implemented in this session. Other audit findings are outside this plan.

## Problem and intended result

Criterion extraction determines what the workflow must prove. Reconciliation maps those stable criteria to the author's coverage claims. A reconciliation timeout currently becomes an empty mapping, so evidence preflight asks the author for missing coverage even when the claims already exist. Later segments reuse the criteria and perform deterministic matching, but never retry the failed semantic mapping.

In the audited run `b861b106-c452-4c98-9c0a-86f450e247cc`, extraction succeeded, reconciliation timed out after about 45 seconds, and six material criteria remained classified as missing coverage through two repair segments. The author cannot repair a service failure by submitting more proof.

After this fix, stable criteria remain frozen once per run. Mapping can recover independently. Exact matches survive a model failure; unresolved service failures pause for infrastructure recovery; actual missing coverage still reaches the author evidence gate.

## Implementation

### 1. Separate mapping outcome from extracted criteria

Refactor `src/server/workflows/context.ts` so reconciliation returns validated mappings plus an explicit outcome, failure cause, and input fingerprint. Persist this outcome with the submission context using backward-compatible optional fields in `src/shared/workflow.ts`. A successful response with no matches is distinct from an unavailable or invalid response.

Always compute deterministic mappings first. On timeout, transport failure, or invalid model output, retain that baseline instead of replacing it with empty arrays. On successful semantic output, use the existing ID validation, deduplication, and ambiguity checks. Do not infer proof classes, evidence links, or coverage from a model response.

Keep run-level canonical IDs, text, and extraction provenance immutable. A reconciliation failure must not invalidate successful extraction or cause extraction to run again.

### 2. Retry mapping against the current claims

Move reconciliation orchestration into the capture path in `src/server/workflows/manager.ts`, after either fresh extraction or reuse of the frozen criteria. Reuse deterministic matches and the existing source mapping bridge. Attempt semantic reconciliation when unresolved mappings need it and that input has not already been successfully reconciled. Empty coverage needs no model call and remains an ordinary author gap.

Fingerprint the canonical criteria, bounded claim IDs and text, relevant mapping bridge, and reconciliation contract version. Reuse successful results for identical input, including successful no-match results. New or changed claims can trigger mapping again without triggering extraction. A failed attempt must never be cached as a successful empty result.

Allow one automatic retry for transient timeout or transport failure, with the existing 45-second timeout per execution. Count every actual model execution, including any structured-response repair execution, against a maximum of two executions per recovery operation. Do not layer an unbounded or multiplicative retry loop over the structured runner. Invalid output after the applicable budget becomes an explicit mapping failure.

Use the existing durable execution ledger and scheduler ownership. Record attempt starts and outcomes under `context_reconciliation`; persist the operation identity and consumed budget. Restarts, concurrent captures, and repeated requests must not duplicate calls or reset the budget. Ignore completions for cancelled or superseded captures.

### 3. Route infrastructure failures away from author repairs

If deterministic mappings already suffice, run normal readiness validation using those mappings despite the semantic failure. If unresolved mappings could still depend on the failed service, park the enforced preflight in a typed, recoverable `evidence_reconciliation_error` phase before Persona activation. Record the actual failure and retained mappings; suppress the misleading missing-coverage repair packet for that attempt.

Append the phase and its permitted details to the shared lifecycle registry and update all affected decoders and consumers. Do not merely return readiness `unavailable`: the current manager only blocks `gaps`, so that change alone would allow an enforced gate to proceed. Preserve the workflow policy distinction between enforced and advisory readiness.

Once reconciliation completes successfully, normal evidence validation decides whether to continue or request genuine author repairs. An infrastructure retry consumes neither a workflow round nor one of the two author evidence refinement attempts.

### 4. Provide recovery for already affected runs

Extend the existing Runs recovery action and server mutation contract with a mapping-specific retry. The current manual infrastructure retry targets failed Persona attempts and cannot recover capture-time reconciliation, so it needs an explicit branch for this failure.

Use an idempotent request ID and the latest eligible frozen submission. Preserve its criteria, evidence references, coverage, and repository scope. Create an immutable recovery segment in the same round with explicit reconciliation-recovery provenance; do not rewrite a previously frozen snapshot, require a new evidence generation, or consume the author refinement counter. Reuse existing capture and reservation machinery rather than introducing another queue or database writer.

For historical runs, recognize a failed reconciliation from authoritative execution records and their source-submission lineage. Offer recovery even when that failure has already exhausted author refinements. Do not infer a timeout from empty mappings alone, and do not automatically mutate all historical runs. Refuse recovery for completed, cancelled, superseded, or otherwise ineligible submissions. Retire any pending obsolete repair delivery when recovery takes ownership.

Show the cause and a clear Retry criterion mapping action in Runs. A second exhausted recovery remains visibly blocked; daemon polling must not keep starting new recovery operations.

## Changed flow

Before: captured claims and extracted criteria go to reconciliation; a model failure becomes empty mappings; the evidence gate sends missing-coverage repairs to the author.

After: captured claims and frozen criteria go to deterministic matching, then bounded semantic reconciliation when needed. Usable mappings go to normal evidence validation and then either Personas or genuine author repair. An unresolved service failure goes to a recoverable infrastructure pause. The Runs retry action starts a same-round recovery segment using the frozen inputs and returns to matching.

## Verification required during implementation

| Acceptance criterion | Focused proof |
| --- | --- |
| Exact coverage survives a failed model response. | Update the regression in `test/workflow-evidence-readiness.test.ts` that currently expects empty mappings after failure; assert the exact claim remains linked and readiness is evaluated correctly. |
| Differently worded claims recover after a timeout. | Inject a timeout followed by a valid mapping; assert extraction runs once, mapping succeeds within its budget, and Personas activate only after readiness permits it. |
| A persistent failure is not blamed on the author. | Assert the typed blocked phase, no author repair delivery, no Persona activation under enforced policy, and unchanged round and author refinement counters. |
| Recovery remains bounded and immutable. | Cover restart, concurrency, cancellation, idempotent retry, late completion, and recovery of an exhausted historical fixture with a failed source reconciliation ledger entry. Assert previous snapshots are unchanged. |
| Real evidence gaps and safe reuse still work. | Cover empty coverage, successful no-match output, ambiguous or unknown IDs, changed claims, and identical successful input. Preserve extraction-once tests and narrow mapping-once expectations to unchanged successful inputs. |
| An operator can recognize and recover the failure. | Extend `e2e/specs/workflow-evidence-readiness.spec.ts` with fake agents and a deterministic failure fixture; exercise the visible cause, retry action, resulting segment, and eventual readiness state. |

Use focused context, readiness, preflight, intent-snapshot, lifecycle, and HTTP tests for the affected contracts, following the repository's required test preload. Run typecheck and lint. Build and run smoke plus the focused Playwright spec for the changed runtime and Runs surface. Register the final focused command output and inspected UI evidence with Mission Control when implementing the fix. Focused mapping, inheritance, review-contract and browser tests now cover the implemented flow.

## Tradeoffs and boundaries

One transient retry can add up to 45 seconds and one model execution to a failed operation. Successful deterministic mapping avoids that cost, and explicit exhausted-state recovery prevents a background retry loop. The additional durable metadata and recovery segment require compatibility and lifecycle tests, but preserve audit history and the existing author repair budget.

This does not increase evidence capacity, change proof-role rules, fix inheritance selection, or address PR-dependent criteria. It repairs the mapping failure and the recovery path described in this comment only. This implementation remains uncommitted for the Mission Control handoff.

## Implementation record

The implementation shares the existing capture, evidence reservation, readiness and workflow
engine paths. Focused tests cover sequential claim replacement, legacy lineage replay, mapping
failure versus successful no-match, bounded retries, same-round recovery, immutable Persona
input, rejected response retention, and substantive failure controls. The Runs browser spec
covers mapping recovery, corrected and exhausted reviews, legacy re-review, and real substantive
objections with fake agents. See [workflow behavior](../../workflows.md) for the shipped contract.

Legacy verdicts without a finding basis remain explicitly unknown and require operator inspection.
The typed basis enforces declared reasons; it cannot guarantee that a model labels prose honestly.
No historical run is automatically resumed. Evidence remains outside version control.
