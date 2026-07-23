# Phase 1: Durable Schedule Foundation

## Outcome and value

Land the complete durable vocabulary that all later Recurring Missions work consumes:

- browser-safe shared schedule and occurrence types;
- one pinned, timezone-aware recurrence evaluator with explicit DST fixtures;
- SQLite tables for schedules, immutable revisions, and occurrences;
- atomic storage primitives for revision changes, occurrence claims, cursor advance,
  recovery reads, archive, and paginated history; and
- nullable schedule provenance on tasks and session task summaries.

There is deliberately no scheduler loop, route, SSE collection, or UI in this phase. With
no schedule producer, the new tables remain empty and the existing product behaves
unchanged. The engineering value is a reviewed persistence and time-calculation contract
that later phases can consume without reopening migrations.

## Entry criteria and direct dependencies

Direct phase dependencies: none.

Before implementation:

1. Confirm the planning pull request containing `docs/plans/recurring-missions/` has merged.
2. Start from the then-current default branch, not planning commit `35807b9`.
3. Re-read [`plan.md`](plan.md) and [`phased-plan.md`](phased-plan.md).
4. Inspect the current `Task` fields, task SQL, overlay list, server constructors, and tests.
   Preserve post-planning fields such as task dependencies, `enabled`, vendor-neutral home
   identity, workflows, and any other additions on default branch.
5. Confirm no other merged feature has already claimed the `mission_schedule_*` table
   names or the three task provenance column names.

## Scope

### In scope

- `src/shared/schedules.ts` with persisted enum arrays, types, health inputs, preview
  result shapes, and normalization helpers that require no `node:` imports.
- Recurrence evaluation in `src/server/schedules/recurrence.ts`.
- Exact dependency installation in `package.json` and the repository lockfile.
- Three schedule tables and indexes in `src/server/db.ts`.
- Schedule row mapping and DB functions, either in `db.ts` or a narrowly scoped
  `src/server/schedules/store.ts` that delegates to `openDb()` and does not open a second
  connection.
- Nullable schedule provenance fields on `Task` and `TaskSummary`.
- The matching `tasks` table columns, `migrate()` calls, row conversion, INSERT/UPSERT, and
  task-summary projection.
- Pure recurrence, schema, migration, and storage tests.

### Explicit non-goals

- No daemon timer or catch-up tick.
- No `TaskManager.create` id override yet.
- No schedule HTTP routes, Registry collection, ServerEvent variants, or web state.
- No catalog, task chip, topbar button, or styles.
- No Electron `powerMonitor`, wake installation, `powerSaveBlocker`, or remote runner.
- No Task Source changes and no new `TASK_SOURCE_KIND`.

## Repository findings and inherited contracts

- `src/server/db.ts` owns the single SQLite connection and all existing task row
  persistence. New tables need no upgrade ALTER, but new columns on `tasks` need
  `addColumn` calls in `migrate()`.
- `openDb()` contains one SQL template literal. Do not place a backtick in SQL comments.
- A unique index used for conflict handling cannot contain nullable columns. Both
  `schedule_id` and `scheduled_for` are non-null.
- Current main persists more task fields than this planning checkout. Extend the current
  column list and row mapper; do not replace them with the older shape shown in historic
  diffs.
- `TaskSummary` is denormalized into `Session.task`; adding schedule provenance there
  changes the nested task JSON but does not add a new top-level Session field. The existing
  session comparator for `task` must remain `byJson`.
- Shared modules imported by the browser cannot use `node:` packages. Cron calculation
  stays server-side.
- Persisted enum arrays are append-only because old values remain in operator databases.

## Authoritative data contracts

Create append-only arrays and their element types for:

```ts
SCHEDULE_EXECUTION_MODES = ["local-catchup", "os-wake", "remote-runner"]
SCHEDULE_OVERLAP_POLICIES = ["skip-active", "allow"]
SCHEDULE_MISSED_POLICIES = ["coalesce-latest", "create-all", "skip"]
SCHEDULE_TRIGGER_KINDS = ["scheduled", "manual"]
SCHEDULE_DECISION_KINDS = [
  "create_task",
  "coalesced",
  "skipped_overlap",
  "skipped_policy",
]
SCHEDULE_OCCURRENCE_STATUSES = [
  "claimed",
  "created",
  "coalesced",
  "skipped_overlap",
  "skipped_policy",
  "failed",
  "cancelled",
]
```

The shared model includes:

- `ScheduleTemplate`;
- `ScheduleDefinition` for the editable cadence/policy/template payload;
- `MissionSchedule`;
- immutable `ScheduleRevision`;
- `ScheduleOccurrence` and compact summaries;
- paginated `ScheduleHistoryPage` that also carries its schedule, including archived
  schedules;
- preview instants and standby-simulation outcomes; and
- schedule health plus reasons, so the server and browser do not invent competing health
  thresholds.

V1 compatibility rule:

- stored rows may contain any known execution mode;
- create/update protocol work in Phase 3 will accept only `local-catchup`;
- `runnerId` is null for V1 mutations;
- encountering a future/unknown persisted value must fail that row closed into attention
  with an explainable error, not silently coerce it to local execution.

Task provenance is represented by the three source-plan fields:

```ts
scheduleId: string | null;
scheduleOccurrenceId: string | null;
scheduledFor: number | null;
```

For a generated task, all three are populated. For every existing task, manual dispatch,
MCP-created phase task, and external-source task, all three are null. Add the same three
fields to `TaskSummary` so provenance survives task-to-session binding.

## File- and component-level implementation steps

### 1. Install and lock the recurrence dependency

1. Evaluate the currently maintained `cron-parser` release against Node 22 and the
   repository's ESM bundling.
2. Install it as an exact runtime dependency and commit both `package.json` and
   `package-lock.json`.
3. Do not add a second date-time library unless a measured parser limitation requires it.
4. Confirm `npm run build:server` bundles the chosen import shape.

### 2. Add browser-safe shared schedule types

Create `src/shared/schedules.ts`.

1. Define the append-only arrays and element types above.
2. Reuse `AgentType`, `TaskKind`, `TaskPriority`, and `ThinkingLevel` from shared types.
3. Define schedule, revision, occurrence, preview, health, and history shapes.
4. Keep calculation APIs and database rows out of this module.
5. Add pure guards/normalizers only where both daemon and browser need identical enum or
   health interpretation.
6. Avoid a parallel schedule list in another module.

### 3. Implement the recurrence seam

Create `src/server/schedules/recurrence.ts` as the only direct `cron-parser` consumer.

Expose an injectable/pure interface equivalent to:

```ts
validate(expression, timezone): Result
nextAfter(expression, timezone, instant): number
between(expression, timezone, afterExclusive, throughInclusive, limit): number[]
preview(definition, after, count): SchedulePreview
```

Rules:

1. Accept exactly five cron fields; reject seconds syntax.
2. Validate IANA zones with `Intl.DateTimeFormat`.
3. Calculate in the selected zone and return UTC epoch milliseconds.
4. Reject schedules whose first two computed occurrences are less than one hour apart.
5. Bound `between` and preview counts before allocating output.
6. Pin spring-forward skip and fall-back single-occurrence behavior in fixtures for at
   least one US zone and one non-US zone.
7. Make preview use the same `nextAfter`/`between` functions the manager will use.
8. Make parser exceptions structured validation failures at the boundary rather than raw
   errors a future route would expose.

### 4. Add the durable schema

Extend `openDb()` with:

- `mission_schedules`;
- `mission_schedule_revisions`;
- `mission_schedule_occurrences`;
- history, recovery, and task lookup indexes.

The occurrence table includes:

```sql
trigger_kind TEXT NOT NULL
decision_kind TEXT NOT NULL
UNIQUE (schedule_id, scheduled_for)
```

Use integer booleans consistently with the existing schema. Store UTC epochs as integer
milliseconds. Do not add foreign keys unless the current database explicitly enables and
uses them; archive/history retention must not become accidental cascade deletion.

The active schedule row points to its immutable revision. Cadence and policies are copied
to the revision row because history must explain the decision in force at claim time.

### 5. Implement schedule storage primitives

Keep all writes on the existing `openDb()` connection. Expose narrowly typed functions for:

- create schedule plus revision 1 atomically;
- update schedule plus next immutable revision atomically;
- get one schedule, including archived;
- list active/non-archived schedules;
- set enabled and recompute/persist a supplied next cursor;
- archive idempotently without deleting revision or occurrence rows;
- read an active revision;
- list enabled schedules due at or before a supplied `now`;
- atomically insert a claimed occurrence and advance the schedule cursor;
- finish an occurrence with a terminal status;
- list stale `claimed` occurrences for recovery;
- find a non-terminal task for a `scheduleId`;
- return a paginated, newest-first history page;
- find occurrence/history context by generated task id; and
- load last-occurrence/health inputs without N+1 reads where practical.

The atomic claim function takes a preallocated occurrence id, nullable task id, the exact
schedule revision, trigger kind, immutable decision kind, optional `coveredById` or
`blockingTaskId`, scheduled instant, claim time, delay, and next cursor. It also takes an
explicit `advanceCursor` flag: scheduled claims advance atomically, while Run now claims
without touching the cron cursor. It returns a discriminated result such as
`claimed | already_exists | schedule_changed` so Phase 2 does not infer transaction
outcomes from affected-row counts in multiple places.

Do not emit Registry events from these functions.

### 6. Extend task persistence without disturbing current-main fields

In `src/shared/types.ts`, add the three nullable fields to `Task` and `TaskSummary`.

In `src/server/db.ts`:

1. Add nullable `schedule_id`, `schedule_occurrence_id`, and `scheduled_for` columns to the
   `CREATE TABLE tasks` definition.
2. Add matching `addColumn` migrations.
3. Extend the current `TaskRow`, `rowToTask`, and INSERT/UPSERT column/value lists.
4. Preserve task dependencies, the `enabled` gate, task-source fields, vendor-neutral home
   columns, session binding, and all fields present on default branch.
5. Consider an index on `tasks(schedule_id, status)` because overlap checks are hot and
   bounded by schedule; nullable values are fine for a lookup index.

In `src/server/tasks.ts`, set all three fields to null in ordinary `TaskManager.create`
results. Phase 2 will populate them for internal schedule producers.

In `src/server/registry.ts`, extend `taskSummaryFor` to project the fields. Fix every
compiler-reported Task literal in tests and support code by assigning null unless it is
explicitly a scheduled-task fixture.

### 7. Add focused tests

Add or extend:

- `test/schedule-recurrence.test.ts`;
- `test/schedule-db.test.ts`;
- the existing task DB/migration tests;
- session contract tests that cover nested `TaskSummary` serialization; and
- bundle smoke coverage if the cron import shape needs it.

Use temporary `MISSION_HOME`/`HARNESS_HOME` isolation before importing DB modules, matching
the existing DB test conventions.

## Data, migration, and compatibility details

- New schedule tables are created on first open for fresh and upgraded databases.
- Existing `tasks` tables receive all three provenance columns through `migrate()`.
- Existing rows read as null provenance.
- No backfill is attempted; there were no scheduled tasks before this feature.
- Schedule edits insert revision `n + 1` and update the active pointer in one transaction.
- Archive sets `archived_at` and disables the schedule; it deletes nothing.
- `next_run_at` is nullable only for paused, archived, or invalid/unavailable schedules.
- `scheduled_for` is an epoch even for manual runs. Phase 2 mints a unique manual instant
  without moving the cron cursor.
- A `claimed` row carries the immutable `decision_kind` and its coverage/blocking
  reference. Recovery finishes that reserved decision; it never recomputes it from the
  schedule's current policy.
- All JSON parsing (template and any health detail) is defensive. One malformed row should
  mark that schedule attention or return a typed error, not prevent every schedule from
  loading.

## Tests and verification

Run targeted tests during implementation:

```text
node --test --import tsx test/schedule-recurrence.test.ts
node --test --import tsx test/schedule-db.test.ts
node --test --import tsx test/session-contracts.test.ts
npm run typecheck
npm run build:server
```

Required assertions:

- five-field validation rejects seconds and sub-hour cadence;
- valid UTC, daily, weekly, and monthly schedules enumerate correctly;
- US spring-forward and fall-back behavior is pinned;
- a non-US zone fixture is pinned;
- preview enumeration and `between` share exact instants;
- schedule/revision round trips preserve policy and template;
- revision increment is atomic;
- duplicate `(schedule_id, scheduled_for)` claims produce one winner;
- claim and `next_run_at` advance together or not at all;
- archived schedules retain revisions and history;
- stale claimed rows are queryable for recovery;
- history cursor/limit ordering is deterministic;
- a database created before the feature migrates all task provenance columns; and
- a normal task still round-trips current-main dependencies, enabled state, home identity,
  source provenance, and null schedule provenance.

## Merge and exit criteria

Phase 1 may merge when:

- all shared schedule types and persisted enums are documented and compile;
- the recurrence dependency is exact and server-bundle compatible;
- recurrence/DST fixtures pass;
- fresh and upgrade schemas pass;
- atomic claim/cursor semantics are tested;
- current-main Task persistence is preserved;
- ordinary tasks and sessions receive null schedule provenance;
- no route, timer, SSE, or UI surface has been introduced; and
- targeted tests plus typecheck and server build pass.

## Downstream handoff

Phase 2 may rely on:

- stable shared type and enum names;
- the recurrence evaluator as the sole time-zone calculation seam;
- atomic create/update/enable/archive and claim/cursor DB primitives;
- recovery and history queries;
- all three Task/TaskSummary provenance fields; and
- empty tables making the manager inert by default.

Phase 2 must not:

- add a second cron parser or duplicate DST logic;
- call `TaskManager.create` inside the claim transaction;
- reinterpret `Task.source` as schedule provenance;
- change occurrence identity or make `trigger_kind` nullable; or
- remove current-main task fields while extending task creation.

## Cross-phase audit record

- 2026-07-23: Moved `trigger_kind` into the initial schema because Run now is V1, avoiding a
  same-feature migration in Phase 2.
- 2026-07-23: Added TaskSummary provenance in the foundation, not the UI phase, so session
  binding cannot discard origin data before Phase 4 renders it.
- 2026-07-23: Defined the atomic claim/cursor return contract here so Phase 2 owns policy
  and recovery rather than transaction shape.
- 2026-07-23: Phase 2 audit found that a bare `claimed` row could not recover a pending
  coalesce/skip after the schedule changed. Added append-only decision kinds,
  `decision_kind`, coverage/blocking references, and explicit cursor advancement to the
  foundation transaction contract.
- 2026-07-23: Checked against Phase 2 needs: due-list, active revision, claim, finish,
  recovery, active-task lookup, and manual/history reads are all owned here.
- 2026-07-23: Checked against Phase 3 needs: create/update/enable/archive/history storage
  operations return typed objects that routes can expose without direct SQL.
- 2026-07-23: Checked against current `origin/main`: phase instructions explicitly
  preserve dependencies, enabled scheduling gate, vendor-neutral home identity, workflows,
  and newer overlay registrations.
