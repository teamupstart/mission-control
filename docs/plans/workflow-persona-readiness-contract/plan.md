# Make Persona reviews respect current evidence readiness

Scope: review comment MC-b828.1, finding 4 of the workflow evidence completion audit. This plan expands the fix into twelve explicit acceptance criteria and includes related corrections to review input, feedback provenance, response validation, and recovery. The review-input contract and recovery are implemented in this session.

## Problem and intended result

The stored Trust walkthrough and Pi retry-guidance reviews demanded missing coverage declarations even though those submissions had ready preflight and three or eight frozen claims. Several failures repeated earlier repair wording as if it described the current submission. These are confirmed historical failures; this investigation has not demonstrated that a fresh call using today's prompt produces the same result.

The current code already tells Personas that coverage declarations are validated elsewhere and are not included in their input. However, `buildPersonaPrompt` receives no actual readiness result. `manager.priorFeedback` collects old failed reviews without submission, round, segment, or attempt identity. The existing disagreement event records every ready-then-fail result, including legitimate semantic failures, and does not prevent an invalid repair request from reaching the author.

The desired boundary is explicit: Mission Control establishes whether coverage is registered and structurally complete; Personas decide whether the delivered evidence actually proves the requested behavior. Ready preflight must not guarantee a Persona pass. A Persona must also not demand that the author repair registration that the daemon has already accepted.

Here, increasing criteria means expanding the acceptance requirements for this fix. The current extraction and coverage schemas already allow 100 criteria and 100 claims; the observed three- and eight-claim failures do not establish a numeric capacity problem.

## Implementation

### 1. Deliver the actual structural result to every Persona

Add a bounded, daemon-generated readiness projection to the Persona attempt input in `src/server/workflows/engine.ts` and `prompt.ts`. Derive it from the exact activated submission's persisted readiness, policy, canonical criteria, and frozen evidence identities. Include submission/round/segment identity, evaluator version, status, and criterion IDs with structural results and the selected claim/evidence references. Keep authored captions and other free text in untrusted evidence sections.

State precisely what the result establishes. `ready` means structural checks passed. `overridden` means the operator bypassed gaps. `unavailable`, `not_evaluated`, and missing legacy readiness mean no successful structural result is known. An advisory policy is explicitly identified. Do not keep the current unconditional statement that preflight validated the packet when the stored result does not establish that.

This projection is supplied natively by the daemon. Authors do not have to register an artifact proving its own registration. Continue delivering the actual images, text, diff, and upstream Check results so Personas can assess sufficiency; the projection does not replace them or expose the raw author coverage packet as something to revalidate.

Freeze the projection and review-contract version on the attempt and include their digest in its input fingerprint. Retries and restart recovery must reuse that attempt input, not a later readiness evaluation. Extend the existing schema and durable-input path; old records remain readable without invented success. Require a coherent, bounded projection before a new-version attempt is sent to a runner.

### 2. Make previous failures visibly historical

Extend `PersonaFeedbackSummary` with optional origin metadata and carry it from the manager through context bounding into prompt rendering: source submission, round, segment, attempt, and reviewer. Preserve that metadata when text is shortened. Bound the history, prefer relevant recent entries, and report omissions.

Render old feedback as prior observations, never as a current preflight report. Mark a structural registration request as superseded only when its criterion can be identified reliably and the current daemon result answers it. Keep unresolved semantic findings visible. Treat legacy entries without sufficient provenance as historical with unknown resolution, rather than guessing that they still apply or have been fixed.

Preserve frozen goals and explicit human decisions. When a goal or transcript includes an old automated repair packet, the current readiness projection establishes today's registration facts; it does not erase the human's requested behavior. Do not rewrite old snapshots or silently strip real requirements with a text-matching rule.

### 3. Enforce the review boundary before emitting repair receipts

Strengthen the common review contract for every Persona, including Code Quality and Intent Conformance, which appear in the historical failures. Require substantive evidence objections to explain the missing behavior, measurement, relevance, or freshness, using the existing validated evidence references. Missing coverage registration and inability to access supplied evidence belong to the daemon/review execution path.

Version the model-facing response contract with a small finding-basis discriminator: substantive review, coverage registration, or evidence access. Keep legacy stored verdicts readable with an unknown basis. Update the model-input schema, normalizer, provider schema, shared stored shape, and prompt together. Existing Check verdicts must not acquire new Persona-only requirements.

Validate new Persona responses against their frozen readiness input before `finishAttemptWithReceipts`. An explicit coverage-registration objection is outside the Persona contract; an evidence-access complaint is a review execution problem. Neither becomes an author repair receipt. A substantive objection remains a normal failure even when preflight is ready.

Use the existing structured-response and infrastructure retry machinery to request one corrected response for a contract violation, with a durable per-operation maximum of two provider executions including the initial call and any parse correction. Do not stack fresh contract, parser, and infrastructure retry budgets. If correction fails again, park the review with an actionable contract-error reason, retain the rejected output, and allow explicit infrastructure recovery without spending an author repair round.

Never synthesize a pass from readiness, delete requests until a failure becomes a pass, or suppress substantive objections in a mixed response. Preserve rejected responses for inspection and require a valid review outcome before emitting verdict receipts. Keyword matching may flag suspicious prose for inspection, but must not automatically rewrite or pass a verdict. A model can mislabel prose, so this discriminator is an enforceable boundary for declared reasons, not proof of perfect semantic compliance.

### 4. Separate actual contract errors from legitimate disagreement

Retain `readiness_review_disagreement` as the existing broad ready-then-fail signal so historical meaning does not change. Add bounded contract-violation and correction-outcome telemetry keyed to the immutable attempt and review-contract version. Distinguish declared registration objections, evidence-access failures, ordinary substantive failures, and unknown legacy reasons.

Update the existing Runs detail and evidence-readiness reporting to show current structural status beside the review outcome and the precise recovery reason. Do not label every ready-then-fail result a false rejection. Keep unknowns and bounded-window omissions explicit, and record no prompt or artifact bodies in aggregate telemetry.

For eligible historical failures, provide an explicit recovery path through a new same-round segment using the existing frozen evidence and criteria and the corrected review-input contract. Keep all earlier snapshots and verdicts intact, preserve receipt ownership, and do not spend an author repair round for a confirmed review-contract fault. Missing legacy basis requires inspection rather than automatic classification. Do not restart historical runs in bulk. The two audited examples are detached; recovery must also satisfy the existing session-binding requirements before any delivery can occur.

## Changed flow

Before: the daemon runs preflight, but the Persona receives only a generic assurance plus old feedback without submission identity. A registration objection can become a fail receipt and another author repair, with disagreement recorded afterwards.

After: the exact preflight result and dated feedback become frozen Persona input alongside real evidence. The response validator checks the review contract before receipts. Valid substantive outcomes follow the graph; contract violations get one bounded correction, then either a valid outcome or an infrastructure pause. The timeline records which occurred.

## Verification required during implementation

| Stable ID | Expanded acceptance criterion | Focused proof |
| --- | --- | --- |
| PRC-01 | Every Persona receives the structural result for the submission it reviews. | Capture runner input across different Persona roles; assert current IDs, selected references, and policy come from the frozen submission, never author prose. |
| PRC-02 | Readiness states are represented honestly. | Cover ready under enforced and advisory policy, gaps, overridden, unavailable, not evaluated, and absent legacy readiness; none is relabeled as a stronger result. |
| PRC-03 | Review input remains immutable across retries. | Test projection fingerprinting, restart, concurrent state changes, and late completion. A changed contract creates a new attempt/input identity and does not edit the old one. |
| PRC-04 | Old repair text cannot masquerade as current readiness. | Reproduce historical missing-declaration wording with a current ready packet; assert source round/segment labels and reliable supersession while real unresolved findings remain visible. |
| PRC-05 | Registration is daemon-owned across all Persona roles. | Inject typed registration objections from Auditor, Code Quality, and Intent Conformance fixtures; no author repair receipt is emitted. Preserve human behavior requirements. |
| PRC-06 | Structurally ready but inadequate evidence still fails. | Negative controls for stale screenshots, unrelated output, unexecuted changed code, and inadequate measurement. Assert normal substantive failures and repair delivery. |
| PRC-07 | Contract validation cannot manufacture approval. | Exercise pure registration, mixed substantive/registration, mislabeled suspicious prose, malformed basis, and unknown evidence IDs. No readiness-based or keyword-based auto-pass is permitted. |
| PRC-08 | Correction is bounded and does not charge author repairs. | Count actual executions across parse correction, contract correction, restart, and explicit retry. Exhaustion produces an infrastructure pause with no fail receipt or author-round increment. |
| PRC-09 | Disagreement reporting distinguishes known causes. | Test idempotent events, original broad-signal semantics, separate correction outcomes, unknown legacy classification, and bounded aggregates without evidence bodies. |
| PRC-10 | Historical recovery preserves audit history and eligibility. | Recover a confirmed legacy contract failure without new evidence, preserve prior snapshots and verdicts, and reject duplicate, detached, cancelled, completed, or superseded recovery as appropriate. |
| PRC-11 | New context is bounded and cannot be spoofed. | Exercise maximum criterion/claim counts, UTF-8 and JSON expansion, truncation, malicious captions and old feedback. Essential authority/identity remains intact; oversize incoherent packets are refused before execution. |
| PRC-12 | Operators can inspect the distinction and recover. | Extend the existing Runs/evidence-readiness Playwright specs with fake agents, covering legitimate ready-then-fail, corrected review, exhausted contract error, and explicit recovery. |

Extend `test/workflow-verdict.test.ts`, `workflow-context.test.ts`, `workflow-security.test.ts`, `workflow-readiness-disagreement.test.ts`, and the existing engine, recovery, and audit tests. Use deterministic runner seams and the required repository test preload. Fake-runner tests establish input and state-machine behavior; they do not establish universal model obedience or reproduce a fresh live-model failure.

Run focused tests, typecheck, and lint; build and run smoke plus the affected Playwright specs. Update `docs/workflows.md` to describe the new receipt and historical-feedback contract. Register final focused outputs and inspected UI evidence during implementation. Focused regression and browser tests use deterministic fake runners; no live model calls were made.

## Tradeoffs and boundaries

The native projection adds bounded prompt and storage overhead, and a contract correction can add one provider execution. Versioned attempt input and legacy verdict compatibility require careful schema tests. The benefit is an inspectable source for registration facts and a recovery path that does not ask authors to repair the reviewer.

This complements the separate timeout and inherited-selection plans; it does not replace their fixes or raise criterion/artifact limits. It also does not make stale evidence current, waive semantic review, or automatically reattach sessions. This implementation remains uncommitted for the Mission Control handoff.

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
