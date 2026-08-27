# Phase 2: Mission Control Commission and Plugin Foundation

## Outcome

Mission Control can durably store and reconcile a Pipeline commission from the generic AI Conductor Engineer lifecycle contract. Its existing visualizer plugin forwards Engineer events through an additive envelope, and the daemon can recover missed live events from the fork's replay surface. The feature remains inactive at dispatch until Phase 3 lands the complete user experience.

This phase lands only in Mission Control. The AI Conductor fork is attached as read-only context and must not be changed.

## Entry criteria and dependencies

- Source plan: `docs/plans/conductor-planning-pipeline-continuity/plan.md`.
- Phased index: `docs/plans/conductor-planning-pipeline-continuity/phased-plan.md`.
- Direct dependency: Phase 1 is merged in `mancej/ai-conductor`.
- Read the exact capability, event, replay, and handoff contract from the merged fork and its Phase 1 PR before editing fixtures.
- The planning PR containing this file is merged.

## Repository scope

### Primary: Mission Control

Implement, test, document, commit, push, and open one Mission Control PR.

### Attached context-only: `/Users/jordan.mance/workspace/upstart/ai-conductor`

Inspect the merged provider contract and tests. Do not edit or open another AI Conductor PR in this phase.

## Scope

- Shared commission identity, lifecycle, projection, and wire contracts.
- SQLite migration for one commission per task plus a bounded commission event ledger.
- Atomic commission store/reducer with monotonic provider revision.
- Optional provider methods for Engineer run create, inspect/replay, and cancel.
- AI Conductor capability probe and JSON command parsing.
- Additive Engineer envelope support in the existing Mission Control visualizer plugin.
- Authenticated ingest, validation, reduction, and event deduplication for Engineer events.
- Five-second active-commission replay/reconciliation using the provider's exact cursor.
- Snapshot and incremental SSE transport for commission projections.
- Internal/contract tests and integration documentation.

## Non-goals

- Do not activate commission creation in Pipeline dispatch yet.
- Do not change Board, Console, Runs, session clustering, or task chips.
- Do not change AI Conductor.
- Do not treat plugin delivery as durable truth.
- Do not write AI Conductor files.
- Do not remove legacy `Task.pipelineRun` or current implementation-run ingestion.
- Do not add browser polling or a second live browser channel.

## Inherited Phase 1 contracts

Use the exact merged values, not the example names in the source plan:

- capability identifier and capability probe output;
- Engineer event discriminants and schema version;
- Engineer run id, correlation id, repository, revision, and timestamp fields;
- create, inspect/replay, and cancel command JSON;
- handoff fields and awaiting-merge meaning;
- durable replay cursor semantics;
- product/technical and tier skip event semantics.

If the provider PR deliberately changed a proposed shape, update this phase file and the phased index before implementation rather than creating a translation guess.

## Verified Mission Control findings

- `src/shared/pipeline.ts` currently models only provider-owned implementation runs keyed by provider, repository, and final slug.
- `src/server/db.ts:2690-2765` persists implementation run projections and events, but has no authoring commission table.
- `src/server/pipelines/types.ts` forbids direct provider-file writes and is the correct home for sanctioned CLI mutation/read capabilities.
- `src/server/pipelines/conductor/index.ts:108-214` rereads state every tick and tails run ledgers independently of live push.
- `src/server/pipelines/ingest.ts` validates repository consent and existing run slugs before accepting current visualizer envelopes.
- `integrations/ai-conductor/mission-control/index.mjs` has a frozen event allowlist, O(1) handlers, bounded retry, and a run-only identity resolver.
- `src/web/useEventStream.ts` handles whole-object run upserts and is the pattern for an additive bounded collection.

## Implementation steps

### 1. Add browser-safe commission contracts

Extend `src/shared/pipeline.ts` with append-only ids and enums for:

- `PipelineCommissionId`;
- commission lifecycle;
- Engineer run link and optional final `PipelineRunLink`;
- authoring step projection using existing `PipelineStep` and frozen provider vocabulary;
- commission projection and key helpers.

Extend `Task` and `TaskSummary` with nullable `pipelineCommissionId`. Add bounded `pipelineCommissions` to the connect snapshot plus whole-object `pipeline_commission_upsert` and identity-only `pipeline_commission_remove` events. Keep new fields optional or nullable for old rows and peers.

Do not add Node imports under `src/shared/`.

### 2. Add the migration and store

In `src/server/db.ts`, add:

- nullable `tasks.pipeline_commission_id`;
- `pipeline_commissions` keyed by commission id with unique task id;
- `pipeline_commission_events` keyed by commission id and daemon-assigned sequence;
- indexes for task, provider/repository, lifecycle, and linked run where justified by actual reads.

Use the repository's additive migration helpers so existing databases open safely. Validate persisted provider ids and JSON on read. A malformed row must degrade to an explicit unsupported/error projection or be quarantined according to existing DB patterns, not crash the whole daemon.

Add atomic create/upsert/read/list/delete helpers. Provider revisions are monotonic and idempotent. Cap event rows per active commission and retire them only with the commission's defined retention lifecycle.

### 3. Add the provider capability seam

Extend `PipelineProvider` with an optional Engineer lifecycle capability object rather than concrete-provider branches in dispatch or routes. It should expose:

- capability detection;
- create/reserve Engineer run;
- inspect/replay after revision;
- cancel/fail where the source plan requires it.

Implement the AI Conductor adapter under `src/server/pipelines/conductor/` using the resolved provider binary and exact merged JSON. Apply timeouts, output parsing, bounded diagnostics, and never trust exit code alone. Never write provider files directly.

Cache capability probing outside the five-second hot path. Replay only exact active commission/run ids known from SQLite.

### 4. Implement the commission reducer

Create one server-owned reducer that converts validated generic Engineer events into the whole `PipelineCommission` projection. It owns:

- monotonic revision checks;
- legal lifecycle movement;
- step start/complete/fail/retry/skip projection;
- tier/track updates;
- worktree metadata;
- exact spec handoff fields;
- terminal protection and explicit unsupported schema behavior.

Mission Control does not second-guess AI Conductor step order or completion. Unknown event kinds are stored as evidence and leave the current projection unchanged.

### 5. Extend the visualizer plugin additively

Update `integrations/ai-conductor/mission-control/index.mjs`, its manifest if required by the merged fork compatibility, README, and contract tests.

- Subscribe to every new Engineer event kind.
- For Engineer events, use identity carried by the event. Do not run it through the implementation `resolveRun` worktree/slug guess.
- Extend the frozen envelope only with optional fields required to identify Engineer scope/run/correlation.
- Preserve current implementation envelope bytes for old events.
- Keep handlers synchronous and O(1), buffer size, batching, retry/backoff, token rotation, 413 handling, and bounded shutdown behavior.
- Update the pinned event list and tested fork revision deliberately.

### 6. Extend authenticated ingest

Teach `src/server/pipelines/ingest.ts` and `src/server/routes.ts` to discriminate current implementation envelopes from additive Engineer envelopes.

For Engineer events validate:

- token authentication and request/body limits;
- known provider and consented canonical repository;
- known non-terminal commission;
- correlation id and Engineer run id match the stored binding;
- event schema and required identity fields;
- revision is newer or an idempotent duplicate;
- handoff's final run key does not collide with another active commission.

Only after validation, append evidence, reduce the projection, update the task's exact final run link when handoff supplies it, and emit one commission upsert. Partial batches must have explicit all-or-item behavior covered by tests.

### 7. Add replay reconciliation

Extend the existing pipeline watcher or add a sibling owned by the same pipeline subsystem. On the normal five-second cadence:

- select only active commissions with an Engineer run id;
- call provider replay after the stored revision;
- feed returned events through the same validator/reducer used by live ingest;
- emit only human-visible projection changes;
- preserve the last good state on temporary read failure;
- surface bounded provider errors without resetting steps.

Live push and replay must converge idempotently regardless of which observes an event first. Keep the browser on SSE only.

### 8. Publish snapshots and internal APIs

Load commissions during Registry startup, include them in the connect snapshot, and emit upsert/remove only after durable writes. Add internal registry methods Phase 3 can use for task/session joins without reading SQLite from the browser or Foreman.

Keep the new dispatch path disabled or unused until Phase 3. A build containing Phase 2 alone must behave exactly like the current product for new Pipeline tasks.

## Data and compatibility details

- Commission id is Mission Control-owned and opaque.
- Engineer run id and provider revision are provider-owned.
- Final run link is null until exact handoff.
- Existing `pipeline_runs` and `pipeline_events` remain implementation-run projections and ledgers.
- Existing plugin envelopes and `/ingest/conductor` callers continue to work.
- Unknown Engineer event kinds are durable evidence but not state transitions.
- Unsupported schema preserves the last good projection and records an actionable error.
- A legacy provider without the capability remains on the current behavior until Phase 3 decides its dispatch posture.

## Tests and verification

Add focused tests for:

- old database upgrade and row parsing;
- one-commission-per-task and cross-repository uniqueness;
- atomic monotonic reducer writes and duplicate convergence;
- event-ledger cap and retirement;
- provider capability/JSON parsing, timeouts, malformed output, and missing binary;
- plugin old-envelope byte compatibility plus every new Engineer kind;
- O(1) handler behavior, retry, token rotation, bounded shutdown, and unknown event handling;
- ingest authentication, repository consent, id/run/correlation mismatch, stale revision, terminal commission, malformed handoff, and collision;
- live-first, replay-first, and restart reconciliation yielding the same projection;
- snapshot/upsert/remove exhaustiveness and bounded payload size.

Run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

No Playwright spec is required in this phase because the new path remains inactive and no visible UI behavior changes. If implementation activates or alters any user-visible behavior, move that behavior to Phase 3 or add its Playwright coverage here before merge.

## Merge and exit criteria

- Migration opens an old database safely and tests never touch operator state.
- Generic events pushed and replayed in either order converge on one durable commission projection.
- Existing implementation-run ingest and polling remain compatible.
- No Pipeline dispatch uses the new capability yet.
- Mission Control tests, typecheck, lint, build, and smoke pass.
- The AI Conductor checkout has no changes.
- The Mission Control PR is green and merged before Phase 3 starts.

## Downstream handoff

Phase 3 may rely on:

- exact shared commission types and key helpers;
- migrated persistence and registry collection;
- provider capability/create/replay methods;
- one reducer for live and replay paths;
- exact handoff-to-run binding;
- snapshot and incremental SSE events.

Phase 3 must not duplicate reduction logic in React, bypass provider capability validation, or write provider state. If this phase changes a proposed shared name, update Phase 3's file before merge and record the deviation in the PR.

## Cross-phase audit record

- 2026-08-27: Phase 1 owns event truth; this phase only validates, stores, and projects it.
- 2026-08-27: Existing run and authoring commission ledgers remain separate to preserve retention and key semantics.
- 2026-08-27: Dispatch activation was deferred to Phase 3 so Phase 2 cannot ship a half-rendered commission UX.
- 2026-08-27: AI Conductor is context-only; consumer adaptation follows the merged contract without modifying it.
