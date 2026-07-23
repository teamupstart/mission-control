# Phase 6 — Recoverable Finalization and Workflow Handoff

## 1. Outcome

Complete the backend product boundary: a human can create a Best-of-N run, explicitly choose an eligible result, and drive a restart-safe select-one finalization that preserves the winner exactly, tears down losers through existing Task owners, and optionally submits the selected clean snapshot into the shipped one-Session Workflow Preview engine.

At the end of this phase the backend is feature-complete and safe to expose in the dashboard. Model recommendations remain advisory; every destructive effect starts from a durable human decision.

## 2. Entry Conditions and Dependencies

- Depends directly on Phase 5.
- A run can reach `awaiting_decision` with a validated recommendation over an exact eligible artifact set.
- Phase 1 external Workflow claims/submission and Phase 2 exact restore/pinned launch primitives are present.
- The baseline supports Workflow Preview. Live/Foreman handoff remains rejected unless those future Workflow capabilities are actually implemented and authorized; it is never silently downgraded.

## 3. Scope and Non-Goals

In scope:

- generic decision/finalizer driver registries and the select-one implementation;
- idempotent public create, read, action, and explicit-delete routes;
- human decision validation and durable finalization intent;
- exact live-winner restoration or exactly-one replacement Task;
- loser cancellation/cleanup through TaskManager;
- optional exact-clean external Workflow handoff;
- finalization recovery, typed remediation actions, cancellation, restore, and retention;
- active-member Workflow binding eligibility enforcement;
- complete backend fault-injection and security tests.

Out of scope:

- dashboard UI;
- automatic selection or automatic destructive finalization;
- push, PR creation, Inspector adoption, publishing, or merge;
- Live Workflow delivery when the Workflow engine does not implement it;
- time-based ref/history pruning;
- deleting linked Workflow history when Ensemble history is deleted;
- before-comparison Workflows for every member.

## 4. Repository Findings That Shape the Work

- `TaskManager.cancel` is the only normal owner that kills a dispatched agent and reclaims its tracked terminal/worktree. Finalization must call it rather than tear down losers directly.
- `TaskManager.complete` deliberately does not reclaim a worktree. A selected live Task can remain available after the Ensemble completes.
- `resetSession` is the one owner for all session-scoped cleanup after a destructive checkout reset. It accepts an injected Git reset function, so exact artifact restore must route through it instead of copying queue/draft/log/Workflow cleanup.
- `WorkflowManager.ensureExternalBinding` / `submitExternal` from Phase 1 own active-note conflicts, exact-clean capture, version validation, activation, recovery, SSE, and Reset semantics.
- Workflow Preview capture requires a live one-Session target. If the selected member session is gone, finalization must first materialize one normal replacement Task at the selected snapshot.
- Existing Workflow binding conflicts are typed and must remain human-visible. Ensemble must not replace or adopt a binding.
- Every mutating route body belongs in `src/shared/protocol.ts` and goes through `parseBody`.
- `Task.source` means scheduled external ingestion and must not be repurposed for Ensemble ownership.

## 5. Implementation Steps

1. Define generic human-decision and finalization contracts.
   - Add versioned decision/outcome schemas to `src/shared/ensemble.ts`.
   - A decision carries a client-stable `requestId`, expected run revision/state, one compiled-policy-compatible outcome, rationale, and explicit destructive confirmation.
   - Generic outcomes include `selected`, `synthesized`, `retained`, and `no_consensus`; `best_of_n@1` accepts only one eligible selected artifact/member or an explicit cancel/no-consensus path declared by its plan.
   - Define durable per-step finalization progress so recovery can distinguish verification, materialization, loser cleanup, continuation/Workflow handoff, and completion.

2. Add typed decision/finalizer registries.
   - Add `src/server/ensembles/decisions/` and `src/server/ensembles/finalizers/`.
   - Resolve implementations by versioned driver id from the immutable compiled plan.
   - A decision driver validates proposed human outcomes against stage inputs and eligible artifacts.
   - A finalizer returns bounded generic effects which the manager validates and performs; it does not receive raw database/Task/Workflow authority.
   - Register select-one without adding a Best-of-N id check to `EnsembleEngine`.

3. Persist the authority boundary before acting.
   - In one transaction, verify `awaiting_decision`, expected revision, request-id idempotency, eligible artifact, and compiled finalization policy.
   - Insert the immutable decision and selected outcome intent, initialize finalization progress, and move the run to `finalizing`.
   - A duplicate equivalent decision returns the same record. A conflicting replay is `409`.
   - No Git, Task, terminal, or Workflow effect occurs before this commit.

4. Verify all preservation prerequisites.
   - Re-read the selected private ref and require it to resolve to the persisted snapshot SHA.
   - Verify base ancestry/repository identity and artifact fingerprint.
   - Persist the verification result.
   - If the selected ref is missing or wrong, remain `finalizing` with a typed restore/ref remediation error and do not cancel any member.

5. Make one exact winner available.
   - Prefer the original selected Task only when its Session/worktree still match the member attempt and the pane is safely idle—not actively running, in copy mode, or awaiting approval/input.
   - Restore that checkout to the selected snapshot with hard reset plus removal of nonignored untracked files, preserving ignored caches.
   - Invoke the restore through `resetSession(registry, session, true, customArtifactReset)` so work queue, drafts, attachments, message log, no-mistakes caches, observed effort, work episode, and any other registered session-scoped state follow the existing reset contract.
   - Re-read HEAD and cleanliness after reset. Persist exact winner readiness only on a full match.
   - If the original Task/session cannot safely be rebound, create exactly one replacement normal Task using a deterministic request identity, persist `materializedTaskId` before dispatch, and launch from `snapshotSha` through the pinned Dispatcher seam.
   - Reconcile a lost response/restart to that same replacement Task; never launch a second replacement.

6. Tear down losers through TaskManager.
   - After winner preservation is durable, call `TaskManager.cancel` for every launching/active nonselected member.
   - Persist each cleanup result separately and mark the member eliminated only after Task state/resource observations agree.
   - A cleanup failure leaves the run in `finalizing` with the exact Task/member remediation; `completed` is forbidden while an unacknowledged loser resource remains.
   - Submitted private refs survive all Task cancellation.

7. Finish without a Workflow handoff.
   - Build a bounded continuation containing original intent, selected member summary, evaluator recommendation/rationale/caveats, and explicit instruction to inspect and ship through the normal provenance-aware flow.
   - For a retained live winner, deliver through existing pane readiness/locking/injection paths only after reset/rebind is ready.
   - For a replacement Task, include the continuation in its initial intent rather than typing twice.
   - Persist a deterministic delivery key and acknowledgement so restart cannot send the continuation twice.
   - Do not open a PR, push, invoke no-mistakes, or mark the Task done automatically.

8. Resolve an optional Workflow handoff at creation.
   - Extend `POST /api/ensembles` preflight to resolve an operator-selected immutable Workflow version through WorkflowManager.
   - Persist its id, version number/name, binding defaults, completion policy, mode, and source display snapshot in the compiled run.
   - Accept only modes/capabilities the installed Workflow engine actually implements. On baseline `57ea5bc`, this means Preview; a Live/Foreman selection is a typed refusal, never a Preview downgrade.
   - Recheck repo-specific Live consent at finalization if a later Workflow phase makes that mode available.
   - Best-of-N v1 implements `after_selection` only; reject `before_comparison`.

9. Execute the exact-clean Workflow handoff.
   - Derive one opaque server-side source key from run id, selected artifact id, and Workflow version id.
   - After the winner is exact and clean, call `WorkflowManager.ensureExternalBinding` for that live selected/replacement Session and pinned version.
   - Persist returned claim/binding identity before continuing.
   - Call `WorkflowManager.submitExternal` with the same key, `expectedHeadSha: snapshotSha`, and `requireCleanWorktree: true`.
   - Persist returned Workflow run/submission identity after each idempotent result.
   - On a capture mismatch, restore the same winner through the same Reset path and resume the same external submission—never create another claim/binding/run/round.
   - Complete Ensemble finalization once the initial Workflow submission is captured and activated. Do not wait for Workflow review, repairs, Inspector, or completion.
   - Do not send the generic shipping continuation when a Workflow handoff is active.

10. Handle Workflow conflicts without hidden policy.
    - If a different active binding owns the selected note key, remain `finalizing` with the typed conflict.
    - Offer only explicit recovery:
      - retry after the operator resolves/removes that binding in Workflow UI; or
      - confirm `skip_workflow_handoff` and finish with the normal continuation.
    - Never replace, archive, adopt, or submit into the conflicting binding automatically.
    - If a linked Workflow is later reset/deleted, Ensemble history remains complete and renders the link as removed; it does not recreate it.

11. Wire the active-member binding guard.
    - From daemon construction, inject a narrow `canBindSessionToWorkflow` guard backed by EnsembleManager into WorkflowManager.
    - Refuse normal manual binding while a Session owns an active member unless its immutable member Workflow policy permits it.
    - The Workflow module receives only an eligibility answer/reason and never imports the Ensemble store.
    - The server-owned after-selection handoff uses the external boundary rather than bypassing the guard.

12. Expose the complete backend API.
    - `GET /api/ensembles`: paginated/filterable compact summaries.
    - `POST /api/ensembles/preview`: side-effect-free server validation and exact launch/budget/
      handoff estimate for the current draft.
    - `POST /api/ensembles`: idempotent validated create and launch.
    - `GET /api/ensembles/:id`: bounded detail.
    - Existing bounded artifact/evidence/patch and manual submit routes from Phase 4.
    - `POST /api/ensembles/:id/actions`: one discriminated `EnsembleActionSchema` covering `retry_stage`, `retry_member`, `withdraw_member`, `decide`, `resolve_finalization`, `cancel`, and `restore_artifact`.
    - `DELETE /api/ensembles/:id`: explicit terminal-history/ref deletion with typed confirmation.
    - Preview and create share one validation/preflight projection so their estimates cannot drift;
      create still revalidates mutable facts immediately before persistence.
    - Every body uses `parseBody`; ids in URLs select records but never bypass current-state/revision checks.
    - `intent` already contains attachment paths serialized by the existing `withAttachments` compose contract; do not invent a second attachment wire format.

13. Make create preflight and launch fully idempotent.
    - The client supplies a stable request UUID; `ensemble_runs.request_id` returns the existing run on retry.
    - Resolve repository, exact base, strategy/version/config, harness/model/effort support, evaluator guidance, Workflow version/mode, budgets, and every production driver before any Task exists.
    - Enable `best_of_n@1` only after review, decision, and finalizer registries are complete.
    - Return an exact launch estimate: initial/max members, concurrency, waves, review calls, artifact kind, decision requirement, finalization, and Workflow handoff.

14. Complete cancel, restore, and explicit deletion.
    - Cancel persists intent, cancels active Tasks through TaskManager, retains ready refs/history, and reaches `cancelled` only after cleanup reconciliation.
    - Restore verifies a ready ref and creates/reuses one normal Task at that snapshot; it never mutates the source checkout.
    - Explicit delete is terminal-only, requires the run id as confirmation, and never deletes Tasks or linked Workflow state.
    - Persist deletion intent/progress in a new `ensemble_deletion_intents` table, delete only validated generated private refs, then delete Ensemble rows and emit `ensemble_remove`.
    - A crash during deletion resumes the same remaining refs; no time-based pruning is added.

15. Recover finalization at startup.
    - Wait until Task/session and Workflow recovery are coherent.
    - Load `finalizing` runs and resume from persisted step receipts.
    - Re-verify refs and winner exactness before any unfinished destructive step.
    - Reconcile replacement Task, loser cleanup, continuation receipt, external claim, binding, and submission by their stable keys.
    - Publish one coherent summary after reconciliation.

## 6. Data, API, and Migration Details

- Reuse Phase 3 decision records and add normalized finalization progress if not already present. Any new column on an existing table requires `addColumn`.
- `ensemble_deletion_intents` is a new table and needs no `addColumn`.
- Do not use a nullable column in a uniqueness/conflict target. Decision request ids, replacement-task keys, delivery keys, source keys, and deletion ref keys are non-null.
- The public create schema contains request id, title, bounded serialized intent, repo root, Task annotations, strategy id/version/config, and optional Workflow version placement. The daemon resolves all referenced records to immutable snapshots.
- Outcome and Workflow linkage stay on Ensemble records; no columns are added to `workflow_bindings`.
- Workflow claims are deleted with Workflow Reset; Ensemble refs/history are not.
- Full detail/patches stay on HTTP; compact SSE adds finalizing progress/error and selected member identity only.

## 7. Tests and Verification

Add focused tests for:

- create request loss/concurrency returning one run and one member set;
- complete preflight refusal before Tasks for invalid repo/base, strategy version, harness/model/effort, driver, budget, Persona, Workflow version/mode, and capability mismatch;
- decision revision/request id idempotency, conflicting replay, ineligible artifact, and missing destructive confirmation;
- recommendation never becoming an implicit decision;
- missing/wrong selected ref preventing all cleanup;
- live-winner safe-idle gating and exact reset through `resetSession`;
- reset clears every registered session-scoped family and verifies HEAD/cleanliness;
- exactly-one replacement Task across response loss/restart;
- loser cancellation through TaskManager and cleanup failure recovery;
- continuation delivery deduplication;
- external claim/binding/submission idempotency at every crash point;
- dirty/wrong-HEAD Workflow capture restoration and same-submission resume;
- active binding conflict, explicit skip, removed linked run, archived pinned version, and unavailable/revoked Live refusal;
- active ensemble member normal Workflow-binding refusal with no Workflow→Ensemble import;
- cancel retains refs; restore creates/reuses a normal Task;
- explicit deletion confirmation, generated-ref validation, crash resume, no Task/Workflow deletion, and `ensemble_remove`;
- finalization restart before/after every effect;
- all mutating route schemas/body parsing and bounded responses.

Run:

```text
npm run typecheck
node --test --import tsx test/ensemble-finalization.test.ts
node --test --import tsx test/ensemble-workflow-handoff.test.ts
node --test --import tsx test/ensemble-http.test.ts test/ensemble-recovery.test.ts
node --test --import tsx test/workflow-bindings-http.test.ts test/workflow-reset.test.ts
node --test --import tsx test/task-cleanup.test.ts test/session-contracts.test.ts
npm run build:server
npm run smoke
npm test
```

## 8. Merge Criteria

- No destructive effect occurs before an explicit durable human decision.
- One exact selected result is available after restart, either in its original Task or exactly one replacement.
- Every loser is reconciled through TaskManager before completion.
- A no-Workflow result receives one continuation; a Workflow result receives one exact-clean external submission, never both.
- Workflow conflicts and unavailable modes block visibly and never downgrade or replace state.
- Cancel/restore/delete preserve the declared retention and ownership boundaries.
- Public create/action APIs expose only behavior this phase can execute safely.

## 9. Downstream Handoff Contract

Phase 7 may rely on:

- idempotent create with an exact launch estimate and stable request id;
- compact list/SSE summaries plus bounded detail/evidence/patch reads;
- one generic action endpoint with typed current-state conflicts;
- explicit decision/finalization progress and remediation;
- Session Task summaries linked to ensemble member identity;
- optional Workflow source/run links in both directions;
- safe restore and explicit terminal deletion.

The UI must preserve human confirmation and cannot synthesize new authorities client-side.

## 10. Cross-Phase Compatibility Audit

Checked against repository baseline `57ea5bc` and Phases 1–5.

- Delegates Task/worktree/terminal cleanup to TaskManager and destructive session reset cleanup to `resetSession`.
- Uses WorkflowManager’s external boundary and keeps Workflow context one-session.
- Does not add an Ensemble Workflow graph node or import Ensemble storage into Workflow code.
- Preserves Preview behavior and rejects unsupported Live/Foreman modes without downgrade.
- Uses shared protocol zod plus `parseBody` for every mutation.
- Keeps `Task.source`, Session fields, PR provenance, Inspector ownership, and the one SSE channel unchanged.
