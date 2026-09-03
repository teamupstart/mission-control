# Phase 4 - Atomic Recovery and Direct-Successor Adoption

## Outcome and value

An operator can recover a failed Engineer commission without losing history or creating duplicate provider work. Retry creates one new immutable attempt and one fresh managed host. If ai-conductor already contains one exact direct successor, Mission Control can review and explicitly adopt it as a distinct reconciled attempt. Task and commission status can no longer drift silently through these actions.

## Entry criteria and dependencies

- Phase 3 is merged in Mission Control.
- Phase 3 is the only direct implementation prerequisite; Phases 1 and 2 are transitive.
- Repository scope: Mission Control only.
- Runtime retry requires provider readiness and owned-attempt capabilities. Historical direct-successor adoption may inspect an older unowned correlation but must satisfy the stricter validation in this phase.

## Scope

- Add one daemon-owned commission recovery service.
- Reserve retries with database compare-and-swap guards.
- Reuse provider create, inspectCorrelation, replay, and cancel.
- Recover safely across response loss and daemon restart.
- Retire the predecessor managed host through the Registry eviction path.
- Launch one fresh host per new attempt.
- Revalidate and explicitly adopt one exact direct provider successor.
- Add operator retry, adoption, abandon, and cancel actions.
- Add task/commission write-time consistency checks and explicit settlement.
- Add concurrency, fault, route, UI, and Playwright coverage.

## Non-goals

- Do not reopen, rewrite, or relabel an existing attempt.
- Do not auto-adopt based on correlation, branch, commit, or PR URL alone.
- Do not adopt a grandchild, forked, skipped, reordered, or ambiguous lineage.
- Do not create a second provider event channel or lineage table outside commission attempts and the event ledger.
- Do not launch a recovery host for an old provider without readiness and ownership capabilities.
- Do not merge pull requests, install credentials, alter Git remotes, or repair provider state automatically.
- Do not infer implementation completion from spec handoff.

## Repository findings and inherited contracts

- Phase 1 provides normalized attempt origin storage and the workspace resolver.
- Phase 2 provides provider-side readiness, ownership fencing, exact lineage, and replay.
- Phase 3 provides capability parsing, owned initial create, structured commission failure/readiness, attention, status drift, and review-only successor candidates.
- `appendPipelineCommissionAttempt` and `bindPipelineCommissionAttempt` already model immutable append and exact binding, but current re-dispatch does not expose a dedicated operator transaction with expected revision guards.
- `dispatchPipeline` already uses create then inspectCorrelation to recover provider response loss. Extract and reuse this logic.
- `Registry.beginEviction` is the sole terminal and SDK session teardown path. Because it is private, expose a narrow Registry-owned operation for this recovery use rather than creating a second teardown implementation.
- Engineer event ingestion already requires commission, attempt number, run ID, attempt key, predecessor, and revision to match before reduction.
- The provider correlation adapter already rejects unordered history.

## Implementation steps

### 1. Define recovery request, result, and durable states

Add browser-safe request schemas with compare-and-swap identity:

```ts
type PipelineRecoveryGuard = {
  commissionId: string;
  activeAttempt: number;
  engineerRunId: string;
  providerRevision: number;
};
```

Retry and adoption requests include this guard. Adoption also includes the candidate run ID and the candidate revision shown to the operator.

Use stable result codes for stale guard, unsupported provider, readiness blocked, recovery in flight, not retryable, candidate changed, lineage mismatch, repository mismatch, handoff mismatch, task conflict, provider outcome unknown, and host launch failure.

Extend durable attempt state only if the current `reserved`, bound, and terminal states cannot represent crash recovery clearly. Prefer the current state model plus bounded recovery metadata over a parallel recovery table. Any added state is append-only and migrated beside the existing attempt schema.

### 2. Probe first, then add a database-first retry reservation

Run the Phase 2 non-mutating environment probe before opening the reservation transaction. It accepts no predecessor run ID and appends no event. A blocked or inconclusive result that policy does not permit returns immediately, creates no attempt, and leaves no recovery reservation. Only a permitted probe result proceeds to the database compare-and-swap below.

Create a DB operation under `BEGIN IMMEDIATE` that:

- loads the commission, active attempt, and task;
- compares active attempt, engineer run ID, provider revision, task ownership, and commission lifecycle to the request;
- confirms terminal failure, retryability, readiness capability, owner capability, and absence of an existing reserved successor;
- inserts exactly one next attempt with a fresh launch key, origin `mission_control`, direct predecessor run ID, and `reserved` state;
- updates the commission active attempt and recovery projection in the same transaction;
- returns an idempotent existing reservation only when every identity field matches the same recovery request.

Two concurrent requests must contend on this transaction and produce at most one inserted attempt. Do not use only in-memory locks or browser button disablement as the fence.

After the new provider run is created, record run-scoped readiness on that new run and revalidate it before host launch.

### 3. Extract a restart-safe recovery service

Create one service under `src/server/pipelines/` used by both the dedicated route and task re-dispatch. It advances a durable attempt through a saga whose steps are safe to resume:

1. run the non-mutating environment probe outside a database transaction and stop without reservation when policy does not permit the result;
2. reserve or load the exact retry attempt from the database CAS only after preflight succeeds;
3. call provider `create` with commission owner, correlation, fresh launch key, and repository;
4. if the response is lost or malformed, call `inspectCorrelation` and accept only the run with the exact launch key, attempt number, owner, repository, idea, and predecessor;
5. bind that provider run to the reserved attempt before any host instruction;
6. invoke provider readiness for the new run;
7. obtain a Registry recovery-launch claim that fences one host for this task and attempt;
8. retire the predecessor host through a narrow Registry method that delegates to `beginEviction` and preserves `session_remove` semantics;
9. launch one fresh managed host with the new attempt identity and caller credential;
10. persist a bounded failure or unknown outcome at the step where proof stops.

After daemon restart, a reserved or bound attempt resumes from durable identity. It does not append another attempt. A bound attempt with no live matching host may resume launch; a live matching host is returned idempotently.

Do not keep a SQLite transaction open across provider or host calls.

### 4. Make provider and host failures explicit

For each external boundary:

- known provider refusal before run creation: mark the reserved attempt failed with the stable reason and leave it visible;
- create response loss: inspect exact correlation before declaring unknown;
- bind persistence failure: do not launch a host;
- readiness block after create: keep the new attempt addressably blocked without host launch;
- predecessor host eviction failure: stop before new launch unless Registry proves the old host cannot act; expose a retryable cleanup action;
- new host launch failure: retain the bound provider attempt and permit exact resume, not another append;
- event ingest mismatch: preserve evidence and require investigation.

Use the task/session cleanup ledgers and existing Registry ownership patterns. Never infer cleanup from `state === "exited"`; wait for `session_remove` where downstream cleanup depends on eviction completion.

### 5. Revalidate a direct successor candidate

Build the review-only candidate during daemon provider reconciliation, not browser polling. Candidate data is bounded and includes:

- current commission and failed predecessor identity;
- direct successor run ID, attempt number, attempt key, owner state, provider revision, terminal state, and handoff identity;
- branch, durable attempt commit and its provenance, and PR URL or local-commit outcome;
- validation status and reason.

Before adoption, repeat every check server-side:

1. the request guard still matches the active failed attempt;
2. provider capability and correlation inspection succeed;
3. exactly one next run exists and it is the direct child at `activeAttempt + 1`;
4. repository, correlation, idea, predecessor, and attempt sequence match;
5. candidate integration owner equals the predecessor owner; an absent candidate owner is allowed only when the predecessor correlation is explicitly unowned, and a valid recorded ownership transfer is required for any owner change;
6. replay from revision 0 is contiguous, bounded, internally consistent, and reaches the inspected revision;
7. the candidate is terminal or awaiting handoff in a state the commission reducer supports;
8. worktree, branch, plan slug, and handoff identities do not conflict;
9. a PR URL, when present, belongs to the task repository and its head branch matches the handoff;
10. the candidate's durable attempt commit and provenance exactly match both the replayed direct-successor journal and the Phase 1 commit adapter result; a changed candidate fails as `candidate_changed`, while a cross-source identity conflict fails as `lineage_mismatch`;
11. no Mission Control retry, different adopted attempt, or live recovery host now competes.

Repository branch and PR checks are validation evidence only. A missing branch or unavailable repository host may block adoption; it never causes provider state to be rewritten.

### 6. Adopt through the existing attempt and event ledger

Under a database CAS:

- append attempt `activeAttempt + 1` with the provider's actual attempt key, run ID, direct predecessor, provider revision 0, and origin `provider_reconciled`;
- make it active only if the guarded predecessor remains active and no attempt already occupies that number;
- record the operator action and candidate fingerprint in bounded audit evidence;
- do not fabricate a Mission Control launch reservation or integration owner for historical work.

Then replay the candidate journal through the existing Engineer event parser, ledger, revision checks, and reducer. If replay stops partway, the next reconciliation resumes after the last committed provider revision. The attempt remains distinct and its origin remains visible.

An adopted settled handoff moves the commission to its normal awaiting-spec-merge projection. It does not mark the task implemented or done.

### 7. Add operator routes and UI actions

Add dedicated authenticated routes for:

- readiness recheck and initial start, if not already complete in Phase 3;
- retry failed Engineer attempt;
- refresh or review direct successor candidate;
- adopt exact successor;
- abandon failed commission;
- cancel active commission and task.

All mutating requests use Zod schemas and the recovery guard. Return `409` for stale/conflicting state, `422` for a candidate that cannot validate, and a bounded `5xx` or outcome-unknown shape where retry safety is not known.

UI behavior:

- one primary next move per attention state;
- disable and explain actions while a recovery is in flight;
- show predecessor and successor as separate attempts in the timeline;
- label adopted attempts as reconciled provider work;
- never imply the old failed attempt became successful;
- keep typed remedy and branch evidence adjacent to the action.

### 8. Couple explicit settlement and guard task writes

Add shared consistency checks at task mutation boundaries:

- refuse marking a task done while its commission is authoring, readiness-blocked, failed with recovery open, or awaiting specification merge without a completion-compatible implementation run;
- explicit abandon settles the commission and task in one daemon-owned transaction, preserving attempt history;
- cancel first records/requests provider cancellation as appropriate, then uses existing task and session cleanup ownership;
- an adopted handoff clears divergence attention but keeps the task running through the normal specification merge and implementation lifecycle;
- legacy status drift remains an operator action, not automatic destructive correction.

Do not add a second automatic task-settlement clock. Extend the current task/provider settlement path and its write guards.

## Data, API, migration, and compatibility

- API: additive recovery routes with exact CAS request fields and stable result codes.
- Attempts: reuse normalized attempt rows and Phase 1 origin. Add bounded recovery metadata only when needed for restart safety.
- Commission projection: additive recovery-in-flight, unknown-outcome, candidate, and audit fields with old-row normalization.
- Event ledger: adopted replay uses existing unique commission/attempt/revision constraints.
- Old providers: retry remains disabled when readiness or owner capability is absent. Direct historical adoption may be allowed only if exact inspect and replay contracts are available and all checks pass.
- SSE: every reservation, bind, readiness, recovery state, adoption, settlement, and attention change emits through existing task/session/pipeline events.
- Unknown outcomes are durable and manually inspectable. Client retries never assume safety.

## Tests and verification

Add focused tests for the state machine and fault boundaries:

- DB CAS: two concurrent retries, stale active attempt, stale provider revision, existing successor, wrong task, wrong run, and restart load.
- recovery service: provider create success, response loss with exact recovery, collision, malformed correlation, bind failure, readiness block, eviction failure, host launch failure, daemon restart at every durable boundary, and idempotent resume.
- Registry: predecessor host uses the existing eviction sequence and emits one `session_remove`; no second teardown path.
- adoption: exact direct successor, grandchild, fork, skipped attempt, wrong predecessor, wrong repository, wrong idea, missing or mismatched owner, valid owner transfer, explicitly unowned lineage, discontinuous replay, oversized event, terminal mismatch, branch mismatch, durable-commit or provenance mismatch across candidate, replay, and adapter, PR repository mismatch, PR head mismatch, competing retry, partial replay resume, and repeated adoption request.
- settlement: abandon, cancel, adopted handoff, done-write refusal, running drift, and implementation-complete success.
- routes: authentication, Zod failures, 409 conflicts, 422 validation, outcome unknown, and bounded responses.
- shared/UI models: primary next move, action enablement, separate attempt labels, and reconciled origin.

Add Playwright specs against the built daemon and fake agents/provider:

- failed commission retry creates one successor and one fresh host;
- double click or concurrent requests do not duplicate work;
- response-loss recovery shows the same provider run;
- readiness block prevents host launch;
- external successor review shows attempt 1 and candidate attempt 2 separately;
- successful adoption replays to the PR handoff without rewriting attempt 1;
- invalid candidate refuses with a precise reason;
- abandon and cancel settle the correct task state;
- task done is refused while commission state is incompatible.

Run:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-commission.test.ts test/conductor-engineer-provider.test.ts test/pipeline-attention.test.ts test/session-exit-signal.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Add new focused test files when that keeps concurrency and adoption coverage readable. Run `npm run test:electron` with the approved macOS sandbox handling if the timeline or recovery panel changes layout.

## Merge and exit criteria

- Full Mission Control gates pass, including new Playwright behavior.
- Two concurrent retries create at most one attempt and one new host.
- Every external-call response-loss point is idempotent, resumable, or durably unknown.
- Old host teardown goes through Registry and produces normal removal semantics.
- Attempt 1 remains byte-for-byte immutable after retry or adoption.
- Only one exact direct successor can be adopted, after server-side revalidation.
- Partial adoption replay resumes without duplicating events or attempts.
- Branch and PR observations never settle provider lifecycle by themselves.
- Explicit abandon and cancel leave task, commission, provider, host, and attention state consistent.
- Task completion writes fail closed against incompatible commission state.
- UI actions state one truthful next move and never imply predecessor success.

## Downstream handoff

This is the final implementation phase. Later work may add broader historical investigation or provider-specific remedies only if it preserves:

- immutable attempts and origins;
- exact direct-lineage adoption as the only automated reconciliation boundary;
- provider ownership of lifecycle evidence;
- the Phase 1 workspace capability matrix;
- Registry-owned eviction;
- provider-run-based task completion.

Any future support for deeper lineage requires a new explicit operator decision and plan.

## Cross-phase audit record

- Initial audit: Phase 4 consumes the exact projection established by Phase 3 and does not duplicate its attention or provider parsing.
- Atomicity refinement: database CAS reserves identity, but no SQLite transaction spans provider or host calls. Restart-safe saga states bridge those boundaries.
- Teardown refinement: expose a narrow Registry recovery operation that calls `beginEviction`; do not make routes or the recovery service implement teardown.
- Adoption refinement: the attempt row is inserted before replay so existing ingest identity checks remain authoritative, and partial replay can resume by provider revision.
- Settlement audit: adopted spec handoff clears divergence but does not mark implementation complete.
- Final audit: every approved source requirement is owned by one phase; retry and adoption consume earlier contracts without weakening workspace authorization, provider ownership, or task-completion semantics.
- CodeRabbit audit: retry preflight is non-mutating; adoption requires exact owner continuity or explicit transfer evidence and validates its durable commit and provenance against both replay and the Phase 1 adapter before CAS.
