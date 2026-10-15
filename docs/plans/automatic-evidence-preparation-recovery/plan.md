# Automatic evidence-preparation recovery

## Confirmed outcome

The operator selected Complete evidence-preparation recovery on 2026-10-14. Recover agent-owned capture failures and coverage gaps, retry system criterion-mapping failures within a durable bound, and begin review when evidence preparation succeeds. Preserve evidence integrity. Scope is this repository and new eligible automatic/live workflow failures; do not silently restart historical blocked runs or mutate the investigated task.

## Existing owners and constraints

WorkflowManager owns capture, delivery and resumption; WorkflowStore owns atomic reservations and durable history. File-backed evidence is checked against registered byte counts and SHA-256. Readiness already provides same-round refinements and bounded continuation to judges. Criterion mapping has a separate explicit recovery using frozen evidence. Reuse these owners, preserve repository/session attribution and delivery uncertainty, and keep the daemon as the only database writer.

## Behavior

1. A new recoverable agent-file capture failure records the exact item and a durable recovery disposition, then delivers one repair packet to the original live session. The packet explains immutable reservations, names all relevant registered sources, and asks for a consistent replacement evidence/coverage set. It does not request a commit or manual workflow resubmission.
2. After confirmed delivery, new evidence or an explicitly restaged parent item and a settled compatible session cause an atomic child evidence submission in the same round. Already frozen valid proof can carry forward; uncaptured text and coverage must be registered again. The failed submission remains unchanged. A stale reservation is not retried as fresh evidence.
3. Capture repair permits three automatic repair segments per round. Exhaustion remains visibly blocked with an actionable reason; integrity is never bypassed. If the session is idle with no new evidence 15 minutes after confirmed delivery, record a visible stalled outcome requiring operator intervention. Mapping failures get at most two automatic recovery operations per round, delayed 30 and 120 seconds, reusing frozen evidence. Each retains the mapping operation's existing execution budget.
4. Preview, manual-policy, external-artifact, SessionAction-continuation and incompatible-session boundaries remain in force. Restart resumes the same prepared delivery or reserved child without resetting counters. Uncertain delivery blocks further automatic work. Explicit manual recovery remains available.
5. Existing coverage readiness and its six/three total-attempt policy remain authoritative. Coverage exhaustion can continue to review with gaps; capture integrity exhaustion cannot.

Flow: capture failure -> durable recovery record -> existing session delivery -> agent registers corrected proof -> daemon observes completion/new evidence -> fresh immutable child -> readiness -> reviewers. Mapping failures instead follow durable delayed retry -> frozen-evidence recovery -> readiness.

## Implementation and verification

- Extend append-only evidence/delivery contracts and the lifecycle decoder for typed preparation-recovery detail. Keep new durable behavior distinguishable from historical blocked rows.
- Add store reservations with same-round lineage, persisted retry budgets and duplicate-request guards; extend manager failure handling, delivery recovery and sweeps.
- Update run explanation and recovery posture to show repair, retry and exhaustion. Add a real Playwright capture-failure-to-review regression before changing UI behavior, using fake agents only.
- Add focused node:test coverage for stale duplicate-path registrations, immutable old evidence, agent delivery, fresh capture, mapping retry success/exhaustion, restart, cancellation, unchanged inputs, manual/preview policy and uncertain delivery.
- Run focused regression tests, typecheck, lint, build, smoke and the affected Playwright specs. Keep reports and all verification artifacts uncommitted. Update workflow technical documentation with actual shipped behavior.

## Evidence basis

Verified at d5485186: src/server/workflows/images.ts inspectOpenTextFile and captureSubmissionTextArtifacts; store.ts stageWorkflowEvidence and reserveEvidenceReadinessRefinement; manager.ts captureAndActivate, recoverEvidence and sweepResumptions. The incident's old/new handoff registrations had incompatible hashes for one path. No dependency or account prerequisite is assumed.
