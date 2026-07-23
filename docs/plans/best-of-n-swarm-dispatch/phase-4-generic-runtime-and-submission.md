# Phase 4 — Generic Ensemble Runtime and Submission

## 1. Outcome

Build the strategy-neutral execution engine that can launch bounded waves of normal Mission Control Tasks from immutable inputs, accept attributable member submissions, capture immutable artifacts, advance compiled barriers, and resume safely after a daemon restart.

At the end of this phase a test strategy can execute multiple waves end to end. Best-of-N compilation exists, but the production Best-of-N create path remains unavailable until its comparative evaluator lands in Phase 5.

## 2. Entry Conditions and Dependencies

- Depends directly on Phase 2 for pinned dispatch, snapshot/restore helpers, and launch-scoped Mission MCP.
- Depends directly on Phase 3 for compiled plans, durable state, attempts/artifacts, strategy catalog, and registry summaries.
- Both dependencies must be merged because this is their first fan-in.
- The daemon remains the only database writer; the Foreman worker is not an execution host for this engine.

## 3. Scope and Non-Goals

In scope:

- a per-run serialized, restartable `EnsembleEngine`;
- generic stage readiness, barriers, driver commands, hard budgets, and command idempotency;
- preflight and create-wave-before-launch orchestration;
- role-aware prompts and pinned member inputs;
- TaskManager/Dispatcher launch through the Phase 2 options;
- authenticated MCP submission with Session → Task → active member attribution;
- manual HTTP submission fallback using the same server-side attribution rules;
- the `git_snapshot` artifact adapter, evidence materialization, and restore verification;
- generic internal cancel, withdraw, retry, and restore operations;
- read-only run detail and bounded artifact evidence routes;
- startup recovery and focused fault-injection tests.

Out of scope:

- production comparative model evaluation;
- ranking, recommendation, human select-one decision, or finalization;
- Workflow handoff;
- dashboard creation/detail UI;
- strategy-specific branches in the engine;
- automatic dispatch from Foreman or model-authored commands.

## 4. Repository Findings That Shape the Work

- `Dispatcher.dispatch(taskId)` and worktree provision/teardown live in `src/server/dispatcher.ts`; TaskManager is the correct higher-level owner for dispatching a persisted Task.
- `TaskManager.dispatch` currently launches asynchronously and returns the latest Task. The engine must observe durable Task/Session state through the registry rather than assuming the call means the agent is ready.
- Member Tasks must be inserted as backlog rows before a launch wave begins. `TaskManager.create`/dispatch behavior and dependency guards remain authoritative.
- Claude and Codex receive the same Mission MCP descriptor only for daemon-dispatched launches after Phase 2. Operator-started sessions cannot submit for an ensemble unless they are already attributable to the exact active member.
- MCP arguments are validated twice: shared protocol zod and hand-written schemas in `src/mcp/server.ts` must move together.
- The hooks for both shipped harnesses are available only under their declared capabilities; Codex hooks are launch-scoped. Engine progress cannot treat hook silence as completion.
- Task terminal state, session cwd, worktree path, cancellation, teardown, and branch cleanup stay owned by TaskManager/Dispatcher. Ensemble records observe/link these facts; they do not become a second Task state machine.
- The existing SSE channel can wake the manager, but recovery must be derived from SQLite plus current registry state rather than from missed events.

## 5. Implementation Steps

1. Add an injected per-run serialization primitive.
   - Create `src/server/ensembles/engine.ts`.
   - Serialize all events for one run: create, Task/Session observations, submission, driver completion, operator action, cancel, and recovery.
   - Permit different runs to progress concurrently within global budgets.
   - Never hold a database transaction across Task, Git, terminal, or LLM side effects.

2. Define the bounded command vocabulary.
   - Convert ready compiled stages into generic commands such as `create_member_wave`, `launch_member`, `await_artifacts`, `request_review`, `request_decision`, and `finalize`.
   - Persist a deterministic command key and stage attempt before executing any command.
   - Validate commands against the immutable compiled plan and its hard budgets: maximum members, concurrent members, waves, attempts, review calls, elapsed duration, and retained artifacts.
   - Reject unknown driver kinds and over-budget commands as visible run failures; never best-effort past a hard stop.
   - Keep model/strategy output outside this authority boundary. Only validated engine code can emit executable commands.

3. Implement creation preflight in `EnsembleManager`.
   - Canonicalize the repository through existing allowlist/repository helpers.
   - Resolve and persist one full `HEAD^{commit}` SHA and informational branch name.
   - Resolve every required harness binary and validate model/effort support before inserting work.
   - Validate strategy, artifact, evaluator, finalizer, and Workflow-handoff capability combinations even if later phases provide some drivers.
   - Persist the run, compiled plan, all logical members for the initial wave, and first stage attempt before launching anything.
   - Keep the external `requestId`/source claim idempotent so a response-loss retry returns the original run.

4. Launch complete waves through normal Tasks.
   - Create every Task in a wave as backlog before dispatching the first.
   - Persist Task/member association transactionally before launch.
   - Dispatch through `TaskManager.dispatch` with the member’s requested model, effort, exact input `baseSha`, and required Mission MCP capabilities.
   - Use the compiled `maxConcurrentMembers` ceiling and launch the next member only after a slot is durably available.
   - Treat dispatch failure as a member attempt failure and let the compiled barrier decide whether the stage can continue.
   - On retry, append a member attempt and reuse the logical member; do not silently create a new ordinal.

5. Generate a harness-neutral role appendix.
   - Add `src/server/ensembles/member-prompt.ts`.
   - Append bounded data to the ordinary Task intent: run display id, role/ordinal/wave, immutable input SHA or parent artifact ids, isolation rule, required deliverable, explicit submission instruction, and prohibition on push/PR/finalization.
   - Never reveal sibling transcripts or paths unless the compiled information policy explicitly supplies immutable parent artifacts.
   - Escape/fence untrusted user content with the shared Phase 1 prompt helpers.
   - Give the agent no server-assigned ensemble/member ids it can use to submit for a sibling; attribution comes from its authenticated runtime.

6. Add the member submission protocol.
   - Add `SubmitEnsembleResultInput` to `src/shared/protocol.ts` and the matching hand-written MCP schema in `src/mcp/server.ts`.
   - Register `submit_ensemble_result` in the existing MCP bundle. Its arguments contain only bounded member-authored summary, claims, and optional test evidence—not ensemble, member, Task, Session, worktree, artifact, or ref ids.
   - Add the daemon MCP route in the existing routes owner. Resolve runtime env/session identity, then derive the active Task and member server-side.
   - Reject wrong cwd, stale/exited session, nonmember Task, inactive/withdrawn member, replay with conflicting content, and submissions after the stage deadline.
   - Return an idempotent prior result for byte-equivalent repeats.

7. Add a manual fallback without weakening attribution.
   - Add `POST /api/ensembles/:id/members/:memberId/submit` with a shared zod body schema.
   - This is an explicit operator action and may name the member in the URL, but the daemon must verify the member is active and its Task/worktree still match the current record.
   - Label the resulting submission source `operator`; do not impersonate MCP/session provenance.
   - Reuse the same capture service and idempotency rules as MCP submission.

8. Implement the artifact adapter registry and `git_snapshot`.
   - Add `src/server/ensembles/artifacts/types.ts`, `index.ts`, and `git-snapshot.ts`.
   - Use a typed exhaustive artifact-adapter registry keyed by the append-only artifact kinds it supports.
   - For submission, persist a `capturing` attempt, call the Phase 2 temporary-index snapshot helper, re-read the private ref/commit, materialize bounded exact base-to-snapshot evidence, and then mark it `ready`.
   - Include observed HEAD, dirty state, diff stats, binary markers, test evidence, truncation flags, and content fingerprint. Member claims remain labeled as claims.
   - Never read sibling live worktrees; later stages consume ready immutable artifacts.

9. Advance stages from durable predicates.
   - Recompute readiness from compiled dependencies, ready artifacts, member statuses, and stage attempts after every serialized event.
   - Support all/any/threshold barriers generically, including an explicit impossible-barrier failure when too many members fail or withdraw.
   - Wake the run after an artifact becomes ready; never advance based only on Task `done`, idle state, or a hook Stop event.
   - Let a test-only driver demonstrate a second wave from parent artifact inputs without adding a production strategy.

10. Add generic internal recovery actions.
    - `cancelRun`: persist intent, cancel active Tasks through TaskManager, retain immutable refs, and reach `cancelled` only after observations settle.
    - `withdrawMember`: prevent new launches/submissions for the member, cancel it if active, then recompute barriers.
    - `retryMember`: only after the prior attempt is durably failed and its worktree is gone.
    - `retryStage`: append a bounded stage attempt using the compiled retry policy.
    - `restoreArtifact`: verify the private ref and restore into the member Task/worktree through the Phase 2 helper without switching a real checkout branch.
    - Keep these manager methods internal in this phase; Phase 6 exposes the complete action API once finalization semantics exist.

11. Recover on daemon startup.
    - Load non-terminal runs after Task/Workflow registry reconstruction.
    - Mark orphaned running stage attempts as interrupted where their side effect cannot still be active.
    - Reconcile persisted members with current Tasks/Sessions/worktrees and private refs.
    - Resume idempotent command keys or append a permitted retry; never duplicate a Task, member ordinal, artifact attempt, or wave.
    - Recompute stage readiness and republish compact summaries.

12. Add bounded read APIs.
    - `GET /api/ensembles/:id` returns the validated detail graph with pagination/limits for events and attempts.
    - `GET /api/ensembles/:id/artifacts/:artifactId` returns metadata and bounded evidence.
    - `GET /api/ensembles/:id/artifacts/:artifactId/patch` returns an explicitly capped patch response with truncation metadata.
    - No create route is enabled in this phase. Phase 6 enables it only after Phase 5 supplies the
      production evaluator and the human decision/finalization boundary is complete.

## 6. Data, API, and Migration Details

- Use the Phase 3 tables; add an existing-table column through `addColumn` only if implementation proves a missing normalized field. Prefer versioned plan/metadata JSON for strategy-owned data.
- Extend Task creation only through existing validated inputs. Ensemble ownership remains in `ensemble_members`, not `Task.source` (which means external scheduled ingestion).
- Persist Task ids before dispatch and member attempt ids before any worktree side effect.
- The MCP route authenticates through existing launch runtime/env and session resolution. Caller-supplied ids never establish authority.
- Add schemas for every new mutating route in `src/shared/protocol.ts` and route all bodies through `parseBody`.
- Full patches are HTTP-only and bounded. They never enter SQLite, the registry snapshot, or SSE.
- Engine wakeups may be driven by registry events, but all decisions are recomputed from durable state.

## 7. Tests and Verification

Add focused tests for:

- command-key idempotency and per-run serialization under simultaneous Task, submit, and cancel events;
- wave insertion is complete before first dispatch;
- pinned identical input SHA across members after source HEAD moves;
- member concurrency and all hard budget ceilings;
- partial launch failure and impossible barrier behavior;
- retry appends an attempt without changing logical member/ordinal;
- role prompt isolation, fencing, caps, and push/PR prohibition;
- MCP happy path for both launched harnesses;
- MCP rejection for missing runtime, stale session, wrong cwd, nonmember Task, sibling guess, withdrawn member, and late/conflicting replay;
- manual fallback provenance and identical artifact capture path;
- snapshot evidence and private-ref verification;
- all/any/threshold barriers and a test-only two-wave strategy;
- restart before/after Task creation, dispatch, artifact capture, and stage transition;
- cancel/withdraw/retry/restore calls delegate Task/worktree effects to their existing owners;
- compact SSE remains free of patches and transcripts;
- bounded detail/patch routes.

Run:

```text
npm run typecheck
node --test --import tsx test/ensemble-engine.test.ts test/ensemble-submission.test.ts
node --test --import tsx test/ensemble-recovery.test.ts test/ensemble-artifacts.test.ts
node --test --import tsx test/dispatcher-cleanup.test.ts test/session-contracts.test.ts
node --test --import tsx test/harness-hooks.test.ts test/harness-control.test.ts
npm run build:mcp
npm run build:server
npm run smoke
```

Then run `npm test`.

## 8. Merge Criteria

- A deterministic test strategy launches at least two bounded waves without an engine branch on strategy id.
- Every initial member in a wave exists durably before dispatch starts.
- All launched worktrees verify the persisted input SHA.
- MCP submission can affect only the active member attributable to its authenticated Session/Task.
- Ready artifacts are immutable, restorable, and contain honest bounded evidence.
- Restart and concurrent events do not duplicate Tasks, members, attempts, commands, or artifacts.
- No production route can create a Best-of-N run before its evaluator exists.

## 9. Downstream Handoff Contract

Phase 5 may rely on:

- generic review-stage readiness and persisted stage/evaluation attempts;
- ready immutable artifact sets and bounded anonymous evidence materialization;
- the daemon-owned review scheduler from Phase 1;
- generic command validation, retries, budgets, per-run serialization, and recovery;
- compact summaries and bounded detail endpoints;
- production `best_of_n` compiled plans whose review driver is deliberately not yet executable.

Phase 5 must add an evaluator implementation to the review-driver registry, not special-case Best-of-N in `EnsembleEngine`.

## 10. Cross-Phase Compatibility Audit

Checked against repository baseline `57ea5bc` and the Phase 1–3 contracts.

- Uses TaskManager/Dispatcher as the only Task/worktree/terminal lifecycle owners.
- Uses both protocol zod and MCP-local zod for new tool arguments.
- Uses launch-scoped MCP only for daemon-dispatched sessions; no global Codex trust or operator-session claim is introduced.
- Treats hook silence and idle/Stop as insufficient submission evidence.
- Adds routes through the existing daemon router and bodies through `parseBody`.
- Keeps the one SSE channel compact and makes detail HTTP-only.
- Adds no `Session` field and no parallel Task-source meaning.
