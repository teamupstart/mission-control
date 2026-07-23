# Phase 2: Exact-Once Scheduler and Durable Catch-Up

## Outcome and value

Turn Phase 1's durable schedule model into a daemon-owned scheduling engine that:

- creates only ordinary backlog tasks;
- accounts for every crossed schedule instant exactly once across repeated ticks,
  restarts, clock jumps, and system standby;
- applies explicit missed-run and overlap policies;
- recovers both crash windows around task creation;
- supports paused Run now without moving the cron cursor; and
- logs due, delayed, coalesced, skipped, failed, and recovered outcomes.

The manager starts with the daemon but is inert when no schedules exist. There is still no
HTTP, SSE catalog collection, or UI in this phase. The repository remains operable and the
engine is testable entirely through storage fixtures and an injected clock.

## Entry criteria and direct dependencies

Direct phase dependency: Phase 1 — Durable Schedule Foundation.

Before implementation:

1. Confirm Phase 1 merged; rebase onto that merge.
2. Run Phase 1's recurrence, DB, typecheck, and server-bundle checks unchanged.
3. Re-read [`plan.md`](plan.md), [`phased-plan.md`](phased-plan.md), and
   [`phase-1-durable-schedule-foundation.md`](phase-1-durable-schedule-foundation.md).
4. Verify the actual names and discriminants of Phase 1's schedule store API; consume them
   rather than starting parallel SQL helpers.
5. Reinspect current-main `TaskManager.create`, Registry task emission, task dependencies,
   the autopilot `enabled` gate, `startTaskSourceSweeper`, `unref`, and daemon shutdown.

## Scope

### In scope

- Pure missed-run, overlap, health, and catch-up planning functions.
- Recovery-safe internal task creation through `TaskManager`.
- A `ScheduleManager`/service API for preview, durable CRUD orchestration, enable/disable,
  Run now, archive, history, explicit tick, and recovery.
- One self-rescheduling schedule loop integrated into daemon start/stop.
- Fire-time repository revalidation.
- Outcome logging and injectable clock/timer/I/O seams.
- Manager and TaskManager idempotency tests.

### Explicit non-goals

- No HTTP route or zod request schema.
- No ServerEvent variant, Registry schedule map, EventSource state, or browser API call.
- No React component or CSS.
- No Electron resume channel and no OS wake installation.
- No remote runner or multi-daemon lease.
- No direct dispatch, assignment, worktree creation, terminal operation, or pane write.
- No Foreman worker change.

## Repository findings and inherited contracts

- Phase 1 owns recurrence and all schedule SQL primitives. This phase may add a narrowly
  missing primitive only after recording why the foundation contract was insufficient.
- `TaskManager.create` currently mints an id and immediately persists/emits through
  Registry. The schedule path needs an internal preallocated id, but ordinary callers must
  retain the same API and UUID behavior.
- A task with explicit title does not invoke model titling. Schedule templates require a
  title, so recurring work should never start the asynchronous title path.
- Current main tasks carry durable dependencies and an autopilot `enabled` gate. Generated
  tasks start with `dependencies: []` and `enabled: true` unless the then-current
  `TaskManager.create` input applies those defaults itself.
- `startTaskSourceSweeper` demonstrates the required self-rescheduling, unref'd,
  error-contained loop and shutdown closure.
- The daemon is the only DB writer. Foreman is a separate HTTP worker and must see only the
  generated backlog task.
- System standby pauses Node timers. On resume, the overdue timeout runs; correctness comes
  from the persisted cursor, not from knowing why the timer was late.

## Stable service contract for Phase 3

Create a server-only interface whose concrete names may follow repository conventions but
whose responsibilities are stable:

```ts
interface ScheduleService {
  list(): MissionSchedule[];
  get(id: string): MissionSchedule | null;
  preview(input: SchedulePreviewInput): SchedulePreviewResult;
  create(input: CreateScheduleInput): Promise<MissionSchedule>;
  update(id: string, input: UpdateScheduleInput): Promise<MissionSchedule>;
  setEnabled(id: string, enabled: boolean): Promise<MissionSchedule>;
  runNow(id: string): Promise<ScheduleOccurrence>;
  archive(id: string): Promise<MissionSchedule>;
  history(id: string, cursor: HistoryCursor): ScheduleHistoryPage;
  tick(now?: number): Promise<ScheduleTickSummary>;
  recover(now?: number): Promise<ScheduleRecoverySummary>;
}
```

Phase 3 will put HTTP and Registry adapters around this interface. To avoid retrofitting
the manager after it ships, define an optional notifier now:

```ts
interface ScheduleNotifier {
  upsert(schedule: MissionSchedule): void;
  remove(id: string): void;
}
```

Default to a no-op notifier in Phase 2. Notify only after successful durable writes.
Phase 3 will provide Registry-backed methods without changing manager policy.

## File- and component-level implementation steps

### 1. Extract pure scheduling decisions

Create `src/server/schedules/policy.ts` or equivalent.

Implement pure functions that take schedule/revision state, due instants, existing active
task state, and `now`, then return an ordered decision list without I/O.

Missed policies:

- `coalesce-latest`: earlier due instants become `coalesced`, point to the latest
  occurrence id, and one latest instant creates work.
- `create-all`: create work for at most the newest 50 due instants; record earlier
  instants as coalesced. The cap applies per catch-up/tick and prevents unbounded backlog.
- `skip`: record every crossed instant as `skipped_policy`.

Overlap:

- for `skip-active`, any same-schedule task in `backlog`, `dispatching`, or `running`
  yields `skipped_overlap`;
- `done`, `cancelled`, and `failed` do not block;
- `allow` bypasses this check.

Clarify interaction order in code and tests:

1. Enumerate due instants from persisted cursor through `now`.
2. Apply missed policy to determine which instants may create work.
3. For each create candidate in chronological order, evaluate overlap against current task
   state plus tasks successfully created earlier in the same tick.
4. Persist a terminal policy occurrence even when no task is created.

### 2. Make internal task creation recovery-safe

Extend `CreateTaskInput` or add a separate internal options argument so schedule code can
provide:

- a preallocated task id; and
- the three schedule provenance values.

Rules:

1. Ordinary callers omit the id and still receive a fresh UUID.
2. An internal create with an existing id returns the existing task without rewriting,
   retitling, dispatching, or emitting a duplicate.
3. If the existing task id carries different schedule provenance, fail closed; task-id
   collision is corruption, not idempotency.
4. Schedule-created tasks always pass explicit title and `backlog: true`.
5. The task row is durable before its normal `task_upsert` event.
6. Preserve current-main Task defaults and fields, including dependencies and scheduling
   enabled state.

Keep this idempotency inside `TaskManager`, not in the manager caller, so the invariant
holds on recovery and any future durable producer.

### 3. Implement create/update/enable orchestration

Create `src/server/schedules/manager.ts`.

For definition mutations:

1. Validate recurrence through Phase 1's evaluator.
2. Canonicalize and validate `repoRoot` through the existing `resolveRepoRoot`.
3. Enforce V1 `executionMode = local-catchup` and `runnerId = null`.
4. Create/update immutable revisions through the Phase 1 store.
5. For enabled schedules, calculate `nextRunAt` strictly after the selected anchor.
6. Save paused with `nextRunAt = null`.
7. On resume, calculate the first future run from resume time; pausing should not create a
   hidden debt interval.
8. Notify the optional `ScheduleNotifier` only after the DB returns the durable schedule.

Editing a currently enabled schedule creates a revision and computes the next cursor from
the update time. A claim that already won against the old revision completes with that
revision; later claims use the new revision.

### 4. Implement exact-once tick processing

For one enabled schedule:

1. Read the schedule and exact active revision.
2. Enumerate from persisted `nextRunAt` through the supplied `now`, bounded so malformed
   or stale data cannot allocate without limit. The create-all cap limits tasks, not
   occurrence accounting; process older instants in bounded chunks if needed.
3. Allocate occurrence ids and task ids before claim.
4. Apply pure missed/overlap decisions.
5. Call the Phase 1 claim transaction for each instant with the next cursor.
6. If the claim lost, do nothing for that instant.
7. If the decision is terminal without work, finish the occurrence.
8. If work is required:
   - revalidate `repoRoot` immediately before task creation;
   - if invalid, mark the occurrence `failed` with an operator-readable error;
   - otherwise call recovery-safe `TaskManager.create`;
   - mark the occurrence `created` after task persistence succeeds.
9. If task creation throws, mark `failed` unless the process is crashing; never advance by
   emitting only an in-memory task.
10. Refresh/notify schedule state after terminal occurrence persistence.

No code in this path may call `dispatch`, `assign`, `Dispatcher`, terminal registry,
actions, or pane controls.

### 5. Implement crash recovery before ordinary due work

At manager startup and at the beginning of each bounded health tick:

1. List stale/all `claimed` occurrences with their revision and preallocated task id.
2. If the schedule was archived before the task exists, mark the occurrence `cancelled`.
3. If the task already exists with matching provenance, mark the occurrence `created`.
4. If no task exists and the decision called for work, load the immutable revision and
   create the preallocated task id, then mark `created`.
5. If the original decision was a terminal skip/coalesce, finish it without task creation.
6. Record and log recovery outcome.

Phase 1's claimed row carries the immutable `decision_kind`, schedule revision, trigger
kind, scheduled instant, optional preallocated task id, and coverage/blocking references.
Recovery must use those fields and never recompute policy from the schedule's current
revision after a restart.

### 6. Implement Run now

Run now:

1. Works for enabled or paused, non-archived schedules.
2. Uses the active immutable revision.
3. Mints a server-side `scheduledFor` instant that is unique for that schedule even for
   repeated clicks in the same millisecond.
4. Claims through the same storage path with `trigger_kind = manual`.
5. Applies overlap policy.
6. Creates an ordinary backlog task through the same recovery-safe method.
7. Does not read or advance the schedule's cron `nextRunAt`.
8. Appears in history with actual claim delay and terminal result.

Use Phase 1's explicit `advanceCursor: false` claim option for manual runs; do not simulate
it by writing the old cursor back.

### 7. Add preview and standby simulation to the service

The service preview remains non-mutating:

- return 10–50 future instants using Phase 1 recurrence;
- render-local metadata includes UTC epoch, configured local time/offset, and DST offset;
- optional `sleepStartedAt`/`resumedAt` enumerates crossed instants and runs the same
  missed-policy function;
- identify overlaps with existing enabled schedules as advisory preview metadata;
- label potential late execution honestly; and
- perform no schedule, revision, occurrence, or task write.

Phase 3 will expose this method directly after zod validation.

### 8. Start and stop the daemon loop

Add `startScheduleManager` beside `startTaskSourceSweeper` in `src/server/index.ts`.

Loop requirements:

- one self-rescheduling `setTimeout`, never `setInterval`;
- run immediately at startup;
- recover before processing new due instants;
- never overlap ticks;
- catch errors inside the tick and continue;
- choose the earlier of the next persisted due instant and a maximum one-minute health
  check;
- `unref()` the timer;
- return a stop closure and invoke it during shutdown;
- after laptop standby, let the overdue timer call the same tick with current wall time.

Do not add Electron main/preload/web capability files.

### 9. Add structured operational logging

Emit bounded, non-secret log lines/counters for:

- due instants seen;
- tasks created;
- delay milliseconds;
- coalesced count;
- skipped-policy count;
- skipped-overlap count;
- failures;
- recovered-before-task;
- recovered-after-task; and
- catch-up cap use.

Do not log full task intent. Keep any in-memory totals optional; Phase 3 health is derived
from durable schedule/occurrence data rather than from logs.

## Data/API/compatibility details

- This phase adds no public HTTP API.
- Manager methods are server-only and become Phase 3's route dependency.
- A schedule edited during a tick cannot rewrite the revision already claimed.
- A schedule archived during a claim prevents new claims and either lets a durable created
  task stand or marks a still-uncreated claimed occurrence cancelled.
- Forward wall-clock jumps enumerate crossed instants and apply missed policy.
- Backward wall-clock jumps cannot duplicate due work because the cursor and unique key
  are durable.
- Pausing clears `nextRunAt`; resuming starts from resume time and creates no pause debt.
- Restarting loads the persisted cursor and claimed rows; no in-memory last-run timestamp
  is authoritative.
- Task failure/retry remains ordinary task behavior. The schedule does not redispatch or
  retry a failed generated task.
- The notifier is post-commit and no-op in production until Phase 3 wires Registry.

## Tests and verification

Add:

- `test/schedule-policy.test.ts`;
- `test/schedule-manager.test.ts`;
- targeted `TaskManager.create` idempotency tests;
- daemon lifecycle/start-stop tests where practical.

Inject:

- `now`;
- timer scheduling/clearing;
- UUID allocation;
- recurrence/store functions where a true DB integration is not the target;
- `resolveRepoRoot`;
- `TaskManager`; and
- notifier/log sinks.

Run:

```text
node --test --import tsx test/schedule-policy.test.ts
node --test --import tsx test/schedule-manager.test.ts
node --test --import tsx test/schedule-db.test.ts
node --test --import tsx test/task-title.test.ts
npm run typecheck
npm run build:server
```

Required assertions:

- one due instant creates one backlog task;
- repeating the same tick creates no duplicate task or occurrence;
- no schedule directly dispatches;
- explicit schedule titles skip model titling;
- `coalesce-latest`, `create-all` newest-50 cap, and `skip` persist correct outcomes;
- every task status has the intended overlap behavior;
- a task created earlier in the same tick blocks later work under `skip-active`;
- crash after claim creates the preallocated task on recovery;
- crash after task persistence completes the occurrence without task re-emission;
- recovery rejects a mismatched existing task id;
- edit-versus-tick keeps the claimed revision;
- archive-versus-claim prevents new work and leaves durable history;
- missing repo produces `failed`, not a doomed task;
- Run now works paused, is unique, is labeled manual, and leaves cron cursor unchanged;
- pause/resume creates no hidden backlog of paused instants;
- forward and backward clock jumps are safe;
- simulated standby catches up on the first resumed tick;
- timer is unref'd, self-rescheduling, non-overlapping, and stopped by its closure; and
- notifier calls occur after durable writes and never from a failed transaction.

## Merge and exit criteria

Phase 2 may merge when:

- policy functions are pure and exhaustively tested;
- every due instant reaches one durable occurrence outcome;
- both crash windows recover through the preallocated task id;
- TaskManager's ordinary create behavior remains unchanged;
- generated tasks are backlog-only with complete schedule provenance;
- Run now shares the claim path without moving cron cursor;
- manager startup/shutdown follows repository timer conventions;
- no Foreman, Electron, route, SSE, or UI code changed;
- outcome logs omit task intent; and
- targeted tests, Phase 1 tests, typecheck, and server build pass.

## Downstream handoff

Phase 3 may rely on:

- the stable `ScheduleService` methods;
- create/update already validating recurrence and repository;
- preview being non-mutating and sharing scheduler policy;
- manager lifecycle already active and inert without schedules;
- the notifier interface being the only missing live-state adapter;
- history pages including archived schedule context; and
- all task events already emitted through normal Registry task writes.

Phase 3 must not:

- duplicate recurrence or policy logic in route handlers;
- expose direct DB calls to the browser;
- add polling for schedule state;
- emit schedule events before durable manager operations return; or
- bypass `parseBody` for bodyless-looking mutations.

## Cross-phase audit record

- 2026-07-23: Re-read Phase 1 and found recovery needs a durable pending decision, not only
  a `claimed` status. Reconciled non-null `decision_kind`, coverage/blocking references,
  and explicit cursor advancement into Phase 1 before finalizing this phase.
- 2026-07-23: Kept Run now on the claim path and required an explicit no-cursor-advance
  transaction option, preventing a write-old-value workaround.
- 2026-07-23: Added the no-op notifier contract now so Phase 3 can wire Registry without
  changing scheduler policy after merge.
- 2026-07-23: Confirmed Phase 1's TaskSummary provenance is sufficient for Phase 4 session
  parity and no additional session field is needed.
- 2026-07-23: Confirmed Phase 3 can be a transport/live-state adapter over service methods;
  it does not need to own recurrence, storage, or policy.
