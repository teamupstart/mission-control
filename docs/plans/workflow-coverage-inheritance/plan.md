# Preserve repaired coverage across workflow segments

Scope: review comment MC-252f.1, finding 2 of the workflow evidence completion audit. Inherited claim selection is implemented in this session. The report and the plan for mapping timeouts remain unchanged.

## Problem and intended result

The current readiness evaluator prefers claims declared in the current submission over inherited claims. That lets a replacement claim repair a criterion while preserving its older claims as history. But in the following segment, both the original and the replacement are inherited. The preference disappears, and the evaluator treats them as competing declarations.

In the audited goal-provenance run `344a34dd`, three criteria repaired in round 4 segment 1 became ambiguous in segment 2 while the author repaired two different criteria. The previously accepted execution evidence was still present. Existing replacement tests keep declaring the same criterion in every segment, so they miss the segment where a repaired criterion is left alone.

The intended rule is: a replacement continues to answer for its criterion until the author replaces it again. Carrying history must not reactivate superseded claims. This preserves claim selection, not a previous passing verdict: each new submission must still validate the selected claim against its own frozen evidence and scope.

## Implementation

### 1. Persist which declarations currently answer for each criterion

Keep raw `criterionMappings` and the complete carried claims for mapping provenance and audit history. Add small, daemon-owned, versioned selection metadata to the submission context in `src/shared/workflow.ts`: for each canonical criterion, the effective client claim IDs, plus the source submission used to derive the selection. This is selection state over the existing claims, not a second copy of claim text, proof classes, or evidence links.

An effective set can contain one ID, multiple IDs representing unresolved competing declarations, or no IDs. Retain an expected effective ID even if its claim or evidence was lost during carry, so a later segment cannot silently revive an older claim. Validate metadata against run ownership, canonical IDs, current declarations, and the actual predecessor. Authors cannot supply or override it through `submit_workflow_evidence`.

Make the context fields optional for old snapshots and keep their interpretation in one shared resolver. Preserve frozen snapshots, canonical IDs, author claim IDs, repository scope, and evidence origin metadata. No new database table or external writer is needed; use the existing context persistence boundary.

### 2. Apply one deterministic selection rule

Extract selection from `evaluateWorkflowEvidenceReadiness` into a shared pure helper, used by capture and readiness rather than duplicated in the UI or store.

| Current packet | Effective selection |
| --- | --- |
| Exactly one new declaration maps to a criterion. | Select that declaration; prior candidates become history for this criterion. |
| Two or more new declarations map to it. | Keep those declarations competing and report ambiguity. Never choose by timestamp, lexical ID, evidence count, or which would pass. |
| No new declaration, and the predecessor has a recorded effective set. | Carry that set, including unresolved ambiguity. Older retained claims do not re-enter the selection. |
| No reliable previous selection can be established. | Apply conservative matching to the available declarations; do not guess a winner. Multiple candidates remain ambiguous. |

Require the selected claim to exist in the current frozen packet and remain mapped to the same canonical criterion before treating it as matched. Missing selected claims produce a coverage gap; missing evidence or roles and scope conflicts produce their existing validation gaps. Do not fall back to an older passing claim when the replacement is incomplete or was truncated. Preserve the existing checks for unknown IDs and a claim mapped to multiple canonical criteria.

Selection is independent of proof validity. A unique new claim with a missing execution link still replaces the old claim and remains the effective claim in the next segment. Conversely, two new competing claims stay ambiguous after inheritance, even if one was later lost to a capacity limit. A later unique author declaration can resolve that ambiguity.

### 3. Carry selection through the existing capture path

Extend `criterionBridge` in `src/server/workflows/manager.ts` to provide the predecessor's selection alongside coverage and raw mappings. Use its existing parent selection: the explicit parent for a refinement, otherwise the preceding submission in round/segment order. Never select the source by insertion timestamp or by the latest row at evaluation time.

Resolve and freeze the child selection before readiness evaluation using the same predecessor and evidence reservation as the child capture. On restart, reuse the same source identity; reject a changed or superseded capture. Save readiness from that selection and the child's actual frozen evidence. The source's effective selection remains unchanged.

Keep `carryForwardSubmissionEvidence` in `src/server/workflows/store.ts` responsible for retaining claims and evidence within existing bounds. Update its comments to explain that retained ancestry is historical context and that the evaluator carries effective selection. Do not delete older claims, merge their links into replacements, change artifact limits, or make selection depend on carry ordering.

### 4. Support historical snapshots without rewriting them

For an old predecessor without selection metadata, derive selection from its persisted readiness and original/current claim provenance where that result is unambiguous. For an already-regressed chain, replay the same deterministic selection rules through the actual predecessor lineage in order. This recovers the replacement chosen in segment 1 without treating segment 2's inherited duplicates as a new author declaration.

Bound the lineage walk, detect cycles and missing or inconsistent snapshots, and fail conservatively if provenance is insufficient. Do not infer replacement from claim timestamps or assume every historical ambiguity is this bug. Freeze the reconstructed result only in a new child submission; never overwrite old mappings, readiness, or Persona verdicts.

For waiting or refinement-exhausted runs proven to have this regression, extend the existing Runs/server recovery path to reserve one idempotent same-round recovery segment from the latest eligible frozen packet. Permit unchanged evidence and do not charge an author refinement for correcting daemon selection. Re-evaluate every criterion before activation; unrelated evidence gaps remain visible. Do not automatically resume all runs or recover completed, cancelled, or superseded submissions. Record the source and reason in the timeline, and retire any obsolete pending repair delivery when the recovery takes ownership.

## Changed flow

Before: the parent passes all retained claims and raw mappings to the child; the child forgets the parent's effective selection; original and replacement claims become ambiguous when both are inherited.

After: the parent passes claims, raw mappings, and effective selection through the existing capture bridge. New declarations override selection for their own criteria only. The child freezes the resulting selection, validates it against the child's evidence, and either activates review or reports actual gaps. The child's saved selection becomes the input for the next segment.

## Verification required during implementation

| Acceptance criterion | Focused proof |
| --- | --- |
| Repairing B does not regress repaired A. | Add the failing three-segment case to `test/workflow-evidence-preflight.test.ts`: original A/B gaps, repair A only, repair B only. Assert A's selected ID and readiness remain stable, both criteria pass, and old claims are retained. |
| Selection survives more than one inheritance step. | Extend `test/workflow-evidence-carry-forward.test.ts` through another segment and a new round, including daemon restart and shuffled timestamps. Assert source provenance and selected IDs persist. |
| Real ambiguity is not hidden. | Add pure readiness cases for two fresh claims, inherited unresolved competition, cross-criterion reuse, and inconsistent selection metadata. No arbitrary winner may emerge. |
| Passing history cannot hide missing current proof. | Cover an incomplete replacement, selected-claim truncation, missing linked evidence, role gaps, and scope conflict. Assert the old passing claim is never resurrected. |
| Existing stalled runs can recover safely. | Use legacy snapshots without metadata, including the A-then-B regression and a genuine duplicate declaration. Verify bounded reconstruction, idempotent same-round recovery, unchanged refinement budget, and byte-for-byte preservation of parent snapshots. |
| Runs shows the correct result and recovery behavior. | Extend `e2e/specs/workflow-evidence-readiness.spec.ts` with fake agents: repair A then B, inspect the final readiness, and exercise recovery of a legacy stalled fixture through the real control and route. |

Run focused readiness, preflight, carry-forward, context-schema, and recovery-route tests using the repository's required test preload. Run typecheck and lint, then build, smoke, and the focused Playwright spec for the affected runtime and Runs behavior. Update workflow documentation to explain persistent replacement selection. Register the final focused command output and inspected UI evidence during implementation. Focused regression and browser verification now cover this implementation.

## Tradeoffs and boundaries

The additional metadata is bounded by canonical criterion and claim limits and contains IDs only. It makes the author declaration that currently answers for each criterion explicit without throwing away history. Historical reconstruction is the main compatibility risk; missing provenance must leave a visible gap rather than manufacture a passing result.

This plan does not fix semantic mapping timeouts, increase evidence capacity, change proof-role requirements, or solve PR-dependent criteria. It can be implemented independently of the timeout plan; if both land, their capture and recovery changes should share the existing manager contracts. This implementation remains uncommitted for the Mission Control handoff.

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
