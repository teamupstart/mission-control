# Tasks, queues, and schedules

Tasks are Mission Control's durable units of requested work. They can be filed by an
operator, imported by a task source, created from a recurring mission, or commissioned by
automation. A task may point at the session executing it, but that pointer represents the
current execution, not its complete history.

The [task manager](../src/server/tasks.ts) owns task operations and dispatch integration.
The [queue manager](../src/server/queue.ts) provides work-queue state. Recurring missions
are managed through the [schedule manager](../src/server/schedules/manager.ts) and its
[loop](../src/server/schedules/loop.ts). The daemon composes these services in
[`src/server/index.ts`](../src/server/index.ts), where they share the Registry and its
event publication path.

Foreman can act as a separate, HTTP-only worker that helps progress queued work. It never
writes SQLite directly; its [worker](../src/server/foreman/worker.ts) calls daemon routes
like another client. This keeps task and queue persistence within the daemon boundary.

Read [Dispatch, backlog, and task sources](dispatch-and-backlog.md), [Recurring missions](recurring-missions.md),
and [Work queues and backlog autopilot](work-queues.md) for user-facing behavior. The
binding and cleanup rules remain in the [tasks and worktrees contract](agent-guides/architecture.md#tasks-and-worktrees).

The [shared task-status policy](../src/shared/task-status.ts) defines whether each
`TaskStatus` is active. Provisioning (`dispatching`) and execution (`running`) are active;
`backlog` and terminal statuses are not. Lifecycle guards use `isActiveTask`, and SQL
readers use its derived `ACTIVE_TASK_STATUSES` list. Adding a status to `TASK_STATUSES`
requires an explicit activity decision and an entry in the
[lifecycle contract matrix](../test/task-status-contract.test.ts).

Some consumers deliberately ask a broader question. Schedule overlap, startup loading,
and ensemble submission eligibility include backlog work as well as active tasks. Merge
reconciliation also considers failed and cancelled tasks that may have shipped. These
consumers compose the active policy with their own cases; they do not redefine it.

## Task-source content refresh

The daemon's existing task-source sweeper drives discovery and optional refresh on the same
cadence. `TaskSourceInstance.keepUpdated` defaults to false. The provider registry owns
`readLinked`, which reads known issue identities outside discovery filters; adapters still
return candidates and never write the database.
GitHub linked reads use at most four concurrent CLI calls. An aborted sweep stops scheduling
queued reads; in-flight calls remain bounded by their individual timeout, and aborted results
are not applied. This reduces serial delays without promising that every batch fits the sweep
deadline.

`task-sources/ingest.ts` records import provenance and a normalized content baseline alongside
creation. `task-sources/sync.ts` selects at most 25 eligible linked tasks by last attempt, performs
three-way content comparison, and prepares adoption or conflict reviews. The pure policy lives
in `shared/task-source-sync.ts`. `task_source_sync` holds task-linked history and is cleaned up
with the task; `task_source_seen` independently preserves deletion suppression. Pushed tasks are
marked as excluded, and legacy links require explicit adoption.

`TaskManager.applySourceContent` waits for titling, checks live task content, assignment and
execution eligibility, then commits the task and its baseline together. Registry publishes the
already-persisted task after commit through the existing task event. Source generation and
content checks refuse changes overtaken by configuration, another review, local edits, or a
launch. Recorded work episodes also exclude a rescheduled task from automatic rewriting.

The existing source view exposes persisted reviews; the versioned resolution route rechecks
source ownership and the exact local/source values shown before applying either choice. No new
worker, scheduler, event channel or browser polling loop is introduced.
