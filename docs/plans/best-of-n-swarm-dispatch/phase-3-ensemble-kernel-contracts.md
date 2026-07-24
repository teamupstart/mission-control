# Phase 3 — Durable Ensemble Kernel Contracts

## 1. Outcome

Introduce the append-only shared contracts, durable storage, registry projection, and strategy catalog that make “multi-agent ensemble” a first-class Mission Control concept without launching agents yet.

At the end of this phase:

- an ensemble strategy is a versioned descriptor plus compiler, not a hard-coded Best-of-N branch;
- the built-in `best_of_n` strategy compiles a user request into a generic staged execution plan;
- ensemble runs, members, attempts, artifacts, evaluations, and decisions round-trip through SQLite;
- the registry exposes compact ensemble summaries over the existing snapshot/SSE channel;
- task summaries can link a dispatched task back to its ensemble member without adding a denormalized `Session` field;
- no production route starts work, so partially implemented orchestration cannot be invoked by users.

## 2. Entry Conditions and Dependencies

- Depends directly on Phase 1 because ensemble-to-Workflow ownership uses the external-source identity conventions established there.
- May be implemented and merged while Phase 2 is in progress.
- Workflow Preview Phases 1–3 remain green.
- `best_of_n` is the first strategy id, but all persisted ids and registries are append-only extension points.

## 3. Scope and Non-Goals

In scope:

- shared zod schemas and TypeScript types for ensemble requests, compiled plans, summaries, detail records, actions, and events;
- a versioned strategy descriptor/compiler interface and catalog;
- the first `best_of_n` descriptor and pure compiler;
- SQLite tables and a daemon-owned store;
- a compact registry projection and exhaustive web event reducer handling;
- an optional ensemble-member projection on `TaskSummary`;
- contract, migration, store, compiler, registry, and SSE tests.

Out of scope:

- worktree creation, agent launch, prompt delivery, artifact collection, comparative evaluation, finalization, and Workflow handoff;
- public create/action routes or MCP tools;
- dashboard controls;
- strategy-specific columns on generic tables;
- storing full prompts, transcripts, patches, or evaluator output in SSE snapshots.

## 4. Repository Findings That Shape the Work

- `src/server/index.ts` owns the one registry snapshot and SSE stream. A new top-level collection must be present in `MissionState`, `registry.snapshot()`, the `snapshot` event, and `src/web/useEventStream.ts`.
- `ServerEvent` handling is compiler-enforced in `src/web/useEventStream.ts`; add an explicit `ensemble_upsert` / `ensemble_remove` branch rather than a parallel client channel.
- `Session` additions require `SESSION_FIELD_COMPARATORS`. The ensemble link belongs on the already nested task summary, not on `Session`, so this phase should not add a session comparator.
- `TaskSummary` is already the compact task projection nested on `Session`. It is the
  appropriate owner for a member link, alongside its existing task and provenance fields.
- The daemon is the only SQLite writer. The Foreman worker must not import or mutate the ensemble store.
- New tables need no `addColumn`; future columns added to these tables will.
- Append-only ids are already the repository convention for persisted task sources and background jobs. Ensemble strategy and artifact-kind ids need the same treatment.
- Workflow context snapshots are intentionally one-session objects. Ensemble data must remain separate and link through ids rather than widening `WorkflowContextSnapshot`.

## 5. Implementation Steps

1. Add shared append-only ids and schemas.
   - Create `src/shared/ensemble.ts` for wire/state contracts and
     `src/shared/ensemble-strategies.ts` for browser-safe strategy presentation.
   - Define `ENSEMBLE_STRATEGY_IDS = ["best_of_n"] as const` and its derived type.
   - Define append-only, versioned stage-driver ids for member waves, artifact barriers, comparative
     review, human decision, and select-one finalization. Compiled plans persist these ids rather
     than relying on a current implementation default.
   - Define append-only artifact kinds such as `patch`, `commit`, `branch`, `worktree`, `summary`, `test_report`, and `evaluation`.
   - Define durable status vocabularies for runs, members, attempts, evaluation, decision, and finalization. Keep terminal states explicit and never infer them from nullable timestamps.
   - Define `EnsembleCreateInput`, `CompiledEnsemblePlan`, generic stage/role/driver contracts, compact `EnsembleSummary`, detailed `EnsembleRunDetail`, and action payloads.
   - Put strategy-owned configuration under a versioned `strategyConfig` payload; do not add `candidateCount` or evaluator policy columns to the generic run record.
   - Distinguish locally creatable built-in ids from the bounded opaque strategy/driver keys inside
     persisted compiled snapshots. Creation validates against the exhaustive built-in registry;
     recovery must still load a snapshot written by a newer build and block it as unknown rather
     than failing to parse or recompiling with current defaults.

2. Define browser-safe strategy information and a pure descriptor/compiler seam.
   - Add `ENSEMBLE_STRATEGY_INFO: Record<EnsembleStrategyId, EnsembleStrategyInfo>` in shared code.
     It supplies labels, explanations, capabilities, launch-count semantics, and a generic bounded
     `StrategyFormSpec` the dashboard can render without importing server code.
   - Put the Best-of-N shared input schema/defaults/form specification in
     `src/shared/ensemble-strategies/best-of-n.ts`.
   - Add `src/server/ensembles/strategies/types.ts` with a `StrategyDescriptor` interface containing stable identity, display metadata, current schema version, input schema, compilation, and optional migration/normalization hooks.
   - Have the server descriptor extend/reference the browser-safe info rather than restating labels
     and capabilities.
   - Make compilation pure: validated input plus daemon defaults becomes a `CompiledEnsemblePlan`; it must not read SQLite, spawn a process, or inspect a checkout.
   - Model plans as ordered generic stages with explicit drivers and barriers. Initial driver kinds should cover `member`, `review`, `decision`, and `finalize`, while the plan data owns multiplicity and dependencies.
   - Represent role prompts, artifact requirements, evaluator policy, and finalizer policy as data referenced by stages.
   - Add `src/server/ensembles/strategies/index.ts` as the one typed catalog. Readers resolve by registry lookup, never `if (strategyId === "best_of_n")`.

3. Implement the built-in `best_of_n` compiler.
   - Add `src/server/ensembles/strategies/best-of-n.ts`.
   - Validate bounded candidate count, member role template, harness/model/effort overrides, artifact requirements, evaluator settings, and finalization policy.
   - Compile to a fan-out candidate stage, an all-required-members barrier, one comparative evaluation stage, one human decision stage, and one finalization stage.
   - Generate deterministic logical role keys and ordering. Runtime ids remain daemon-generated and must not be embedded by the compiler.
   - Keep prompt text bounded and declarative; actual fencing and runtime evidence injection land in later phases.

4. Add the durable schema in `src/server/db.ts`.
   - `ensemble_runs`: identity, strategy id/version, source identity, title, repository identity, pinned base ref/SHA, compiled-plan JSON, state, active stage, timestamps, and last error.
   - `ensemble_members`: run id, stable role key, ordinal, task id, status, selected attempt id, timestamps, and last error.
   - `ensemble_attempts`: member id, attempt number, task/session ids, pinned launch facts, status, timestamps, and error.
   - `ensemble_artifacts`: attempt or run ownership, append-only artifact kind, immutable locator/digest/metadata JSON, and timestamps.
   - `ensemble_stage_attempts`: run/stage identity, attempt number, driver kind, command key, input/output JSON, status, timestamps, and error.
   - `ensemble_evaluations`: run and stage-attempt identity, attempt number, evaluator runner/model facts, input fingerprint, result JSON, status, timestamps, and error.
   - `ensemble_llm_calls`: run/stage/evaluation attribution, purpose, runner/model facts, timing, usage, cost, status, and error.
   - `ensemble_events`: append-only bounded audit records for operator-visible orchestration transitions.
   - `ensemble_decisions`: run id, decision version, actor/source, selection JSON, rationale, timestamps, and finalization linkage.
   - Use foreign keys and uniqueness constraints with no nullable columns in conflict targets. Store absent optional identity parts as empty strings only when they participate in a uniqueness key and document the normalization.

5. Implement `src/server/ensembles/store.ts`.
   - Provide transaction-scoped creation of a compiled run and its logical members.
   - Add narrow state-transition methods with compare-and-set preconditions so stale workers cannot move a run backward.
   - Add idempotent inserts for member attempts, stage attempts, artifacts, evaluations, LLM-call records, and audit events using stable operation keys.
   - Add detail reads and compact summary reads.
   - Add restart queries for non-terminal runs, but do not execute them yet.
   - Keep raw SQL and JSON parsing inside the store; return validated domain records.

6. Add the daemon manager/catalog boundary without execution.
   - Add `src/server/ensembles/manager.ts` to validate and compile requests and persist drafts through the store.
   - Do not register public routes in this phase.
   - Inject the strategy catalog and store for tests; avoid module-global mutable registries.
   - Add the manager/store to daemon construction only far enough to populate registry summaries from persisted rows.

7. Extend the shared task and registry projections.
   - Add an optional bounded projection to `TaskSummary`:
     `ensemble: { runId; strategyId; strategyLabel; memberId; ordinal; wave; role; launchedMembers;
     maxMembers; status; resultLabel }`.
   - Populate it by joining tasks to members in the daemon projection; do not copy it onto `Session`.
   - Add `ensembleSummaries: EnsembleSummary[]` to `MissionState` and the registry snapshot, matching
     the existing `workflowSummaries` / `workflowRunSummaries` naming convention.
   - Add `ensemble_upsert` and `ensemble_remove` server events and exhaustive reducer branches in `src/web/useEventStream.ts`.
   - Keep summaries small: ids, title, strategy display identity, state, progress counts, selected member if any, timestamps, and recoverability signal. Detailed evaluations/artifacts remain HTTP-only later.

8. Document the extension contract near the registry.
   - State which ids are append-only.
   - State that a strategy contributes validation/compilation and optional presentation metadata, while the generic engine owns persistence and execution.
   - State that a compiled plan is immutable for a run; retries create attempts, not plan rewrites.

## 6. Data, API, and Migration Details

- This phase adds new tables only, so `CREATE TABLE IF NOT EXISTS` plus indexes is sufficient.
- `ensemble_runs.source_kind` should initially allow only `manual` through an append-only shared
  source-id list. Persist source keys for idempotent callers; append Workflow/Foreman only when a
  real inbound creation path exists.
- Use one uniqueness key for source claims, for example `(source_kind, source_key)`, with both columns `NOT NULL`.
- Persist `strategy_version` and the full validated `compiled_plan_json`. Future descriptor changes must not reinterpret an in-flight run using current defaults.
- Make catalog interfaces generic over a bounded string key so tests/plugins can inject descriptors
  without appending test-only ids to the production tuple. The production catalog remains an
  exhaustive `Record<EnsembleStrategyId, ...>`.
- Artifact rows store locators and cryptographic digests, not large file contents.
- Evaluation and decision payloads are versioned JSON envelopes validated on read.
- No mutating HTTP or MCP API is added. Read-only daemon initialization and SSE projections are the only externally observable changes.

## 7. Tests and Verification

- Add shared schema tests for valid and invalid create inputs, compiled plans, summaries, and versioned payloads.
- Add strategy-catalog tests proving every `ENSEMBLE_STRATEGY_IDS` entry has one descriptor and no descriptor has an unregistered id.
- Add Best-of-N compiler tests for deterministic roles/stages, bounds, defaults, explicit overrides, and invalid configurations.
- Add migration tests that open a pre-ensemble database and verify every table/index and foreign key.
- Add store tests for:
  - atomic run/member creation;
  - source-key idempotency;
  - compare-and-set transitions;
  - attempt numbering;
  - artifact idempotency;
  - detail round-trip;
  - non-terminal restart query.
- Extend session/task contract tests for the optional ensemble projection.
- Extend event-stream tests for snapshot, upsert, and remove behavior.
- Run:
  - `npm run typecheck`
  - the focused ensemble, database, registry, event-stream, and session-contract tests
  - `npm test`

## 8. Merge Criteria

- All shared ids and schemas are append-only and validated.
- `best_of_n` reaches generic compiled-plan data through the strategy catalog; no execution code branches on its id.
- The new store round-trips every record and protects state transitions from stale writes.
- Registry snapshots and SSE updates carry only compact summaries.
- No public path can start an ensemble yet.
- Existing Workflow, task, session, and event-stream tests remain green.

## 9. Downstream Handoff Contract

Phase 4 may rely on:

- immutable `CompiledEnsemblePlan` records with stable stage, role, driver, and barrier identities;
- a typed strategy catalog and the registered `best_of_n` descriptor;
- durable compare-and-set transitions, attempts, artifacts, and restart queries;
- a compact registry/SSE projection;
- task summaries that identify ensemble membership;
- persisted pinned-base fields ready to be populated by the launch runtime.

Phase 4 must not rewrite compiled plans or introduce Best-of-N branches into the generic engine.

## 10. Cross-Phase Compatibility Audit

Checked against repository baseline `57ea5bc`.

- Uses the existing daemon-owned SQLite and SSE architecture.
- Avoids a `Session` field and therefore avoids a new comparator and denormalized queue-style state.
- Extends `TaskSummary`, `MissionState`, `registry.snapshot()`, and `useEventStream` together.
- Keeps Workflow snapshots one-session and links by durable ids.
- Adds no Foreman database access and no second live channel.
- Adds only new tables, so no existing-table `addColumn` migration is required.
