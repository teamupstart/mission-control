# Work units

A work unit is one piece of work, which can span several tasks and sessions. Mission Control
gives it one id, `workUnitId`, stored on each of its tasks. A plan task and the phase tasks
its session creates share one, so one query on that id can later find everything the work
did.

The plan behind this is [`docs/plans/work-unit-id/plan.md`](plans/work-unit-id/plan.md).

## What a work unit is

- **The id.** `wu_` followed by a [ULID](https://github.com/ulid/spec): 48 bits of
  millisecond time and 80 random bits in Crockford base32, 26 characters. It always matches
  `^wu_[0-9A-HJKMNP-TV-Z]{26}$`. The id is opaque. It is not a credential and is never
  redacted, but it does embed the time it was minted.
- **Where it lives.** `tasks.work_unit_id`, read as `Task.workUnitId`. The format, the check
  (`isWorkUnitId`) and the names it travels under are defined once, in
  `src/shared/work-unit.ts`. A new id is minted by `mintWorkUnitId` in
  `src/server/work-unit.ts`, and only `TaskManager` calls it.
- **Written once.** No write changes an id once a task has one. The database enforces it:
  `upsertTask` keeps a stored value whatever the written copy of the task carries, so a
  writer holding a copy read before the id was given can neither erase nor replace it.
- **Chosen by Mission Control.** No request body can name a work unit id. A caller can only
  ask to join the work unit of the task it is running, or to start a new one.
- **A resident run has none.** A resident is a standing agent, not a piece of work. Its task
  has no work unit, and tasks it creates get their own.
- **Older tasks.** A task filed before this existed has no id until it is next dispatched or
  assigned. That gives it a new one and saves it before anything in the same dispatch reads
  it. Nothing is inferred from its plan inputs or dependencies.

## Which tasks share one

| How the task is created | Its work unit |
|---|---|
| MCP `create_task`, called by a session whose own task is a plan task | The plan task's. This is how phase tasks inherit, with no change to the phasing skill. |
| MCP `create_task` with `workUnit: "inherit"`, from any session bound to a task | That task's. A task that only predates the column is given its id first. Refused, with the reason, when the session has no task or its task is a resident run. |
| MCP `create_task` with `workUnit: "new"`, or from a session whose task is not a plan task | A new one. |
| A retro follow-up task | The source task's. |
| A failed chat retried as a new task | The source task's. |
| Best-of-N members, their retries and a replacement | One for the whole run. |
| Dashboard dispatch, a schedule occurrence, an imported issue, a pipeline task, a tour, a launch-failure report | A new one. |
| A resident run | None. |
| Requeue, retry, reassign, restore, runtime transfer (the same row) | Unchanged. |

- A task that inherits copies the value. It is not derived through a parent pointer, so it
  survives the parent being deleted.
- A plan created by a plan inherits, and so do its phases, because a copied id is the same id.
- A session with no task (a discovered session, a home session) has no work unit.
- Which kinds share and which have one is kind behaviour, in `TASK_KIND_BEHAVIOR`
  (`src/shared/task.ts`): `sessionTasksJoinWorkUnit` is true for a plan only, and
  `workUnit` is false for a resident only.
- An automatic inheritor whose source has no work unit (a resident run) gets a new one
  rather than failing. Only an explicit `"inherit"` is refused.

**When two operations reach one task at once.** A child inheriting from a task, a dispatch
and an assign can each find the same older task without an id. Each mints a candidate and
writes it only where the column is still empty, then reads the stored value back and uses
that, never its own candidate (`claimTaskWorkUnitId` in `src/server/db.ts`). So the first
write wins and every operation, and the board, ends up with the same id.

## Reading a work unit

- `GET /api/tasks` returns every task with its `workUnitId`.
- The MCP tools `create_task` (its result), `get_task` and `list_tasks` include `workUnitId`.
- `list_tasks` takes a `workUnitId` filter, an exact match, which lists the tasks of one work
  unit. A value that is not a well-formed id is refused.
- `create_task` takes `workUnit: "inherit" | "new"`. Omit it to let the calling session's
  task kind decide.

Nothing else reads the id yet. No launch environment, exported span or dashboard view
carries it.
