# Work unit id - Phase 1: Id and task record

## Outcome

Every task created from now on has a `workUnitId`, except a resident run's (decision D6,
Jordan's choice in the plan validation repair). A
plan task and the phase tasks its session creates share one. The id can be read through the API and the MCP tools, and tasks
can be listed by it. Nothing else changes: no launch, export or dashboard behaviour.

## Entry criteria and dependencies

- The planning pull request is merged. No other phase.

## Scope

- The id helper, the column and its migration, creation and inheritance rules, an id at
  dispatch for older rows, the read field and the list filter.
- `docs/work-units.md`, new.

Not here: the feature flag, the environment variable, telemetry, the dashboard, shaping.
Nothing in this phase is gated.

## Repository findings

- `TaskManager.create` (`src/server/tasks.ts`) is the only creator. Its second argument,
  `InternalCreateOptions`, exists so that an HTTP body cannot choose an id. Every arm of
  that type requires `id`, and MCP creation passes no internal options at all.
- `upsertTask` (`src/server/db.ts`) has an explicit column list and an
  `ON CONFLICT(id) DO UPDATE SET` list. `TaskRow` and `rowToTask` map the row.
- `addColumn(d, "tasks", ...)` in `migrate()` is the migration pattern. An index on a new
  column is created in `migrate()` too, after the column.
  `CURRENT_DATABASE_SCHEMA_VERSION` is 36, with a changelog comment above it.
- `createMcpTask` (`src/server/routes.ts`) serves `/mcp/tasks`, `/mcp/v2/tasks` and
  `/mcp/v3/tasks`. It calls `registry.findSessionByEnv(env, sessionId, cwd)` only when plan
  inputs or `dependsOnCurrentSession` are present.
- `TASK_KIND_BEHAVIOR` (`src/shared/task.ts`) is the registry of what a task kind does.
- Other creators: `createRetroFollowup` (`src/server/tasks.ts`), `fileChatRetry`
  (`src/server/routes.ts`), the ensemble engine and `TaskManagerGateway.create`
  (`src/server/ensembles/`), schedules, task sources, residents, tours.
- The MCP child lists task fields by hand: `taskConfiguration` in `src/mcp/server.ts`.
  List reads go through `readTaskPage` in `src/server/mcp-task-reads.ts`.
- The repository has no ULID helper and no `ulid` dependency.

## Steps

1. **Shared names and format.** `src/shared/work-unit.ts`, with no `node:` import: the
   pattern `^wu_[0-9A-HJKMNP-TV-Z]{26}$`, `isWorkUnitId(value)`, a pure
   `encodeWorkUnitId(timeMs, random)` (ten characters of time, sixteen from ten random
   bytes), and the four carrier names as constants.
2. **Minting.** `src/server/work-unit.ts` exports `mintWorkUnitId(now?)`, using
   `randomBytes(10)` from `node:crypto`.
3. **Schema.** In `migrate()`: `addColumn(d, "tasks", "work_unit_id", "TEXT")`, then
   `CREATE INDEX IF NOT EXISTS idx_tasks_work_unit ON tasks(work_unit_id)`. Take the next
   schema version and add its changelog line. The column is nullable with no backfill (D3).
4. **Record.** `Task.workUnitId: string | null` in `src/shared/types.ts`, `TaskRow` and
   `rowToTask`. In `upsertTask`, add the column to the insert, and in the update keep a
   stored value: `work_unit_id = COALESCE(tasks.work_unit_id, excluded.work_unit_id)`.
5. **Creation rule.** Give `TaskManager.create` an internal work unit source: inherit from
   a named task, or use a supplied id that passes `isWorkUnitId`, or mint when there is
   none. It must work without a reserved id, because MCP creation passes none. When the
   parent has no id yet, mint and save the parent's first, then copy it. A creation that
   finds its reserved id already stored keeps the stored value. A kind with no work unit
   (step 6) is created with none. An automatic inheritor whose source has none by kind gets
   a new one.
6. **D1 and D6 as kind behaviour.** Add two booleans to `TaskKindBehavior`, each with a
   reader function. One is true for `plan` only and means "tasks this kind's session creates
   join its work unit". The other is false for `resident` only and means "a task of this
   kind has a work unit".
7. **MCP `create_task`.** Add an optional `workUnit: "inherit" | "new"` to the tool and to
   the daemon schema the three routes share. In `createMcpTask`, resolve the calling session
   and its task on every call. `"new"` mints. `"inherit"` copies the caller's task's unit,
   and is refused with a reason when the caller has no task or its task has no work unit. With no value, inherit when
   the caller's task kind says so, otherwise mint. A caller that cannot be resolved, with
   no value, is not an error: the task gets a new unit.
8. **Other inheriting creators.** `createRetroFollowup` and `fileChatRetry` inherit from
   their source task. For a best-of-N run, the first member task mints, and every later
   member, retry and replacement inherits from a member task of the same run. If a run's
   `source_*` fields can name a task, inherit from that task instead.
9. **Older rows.** `TaskManager.dispatch` and `TaskManager.assign` give a task with no id one
   before it is handed to an agent, unless its kind has no work unit.
10. **Reads.** Add `workUnitId` to `taskConfiguration` in `src/mcp/server.ts`. Add a
    `workUnitId` filter to the `list_tasks` tool, `/mcp/tasks/list` and `readTaskPage`: an
    exact match, refused when the value is not a well-formed id. `GET /api/tasks` already
    returns the whole `Task`.
11. **Docs.** `docs/work-units.md` with three sections: "What a work unit is", "Which tasks
    share one" (the table from the plan's section 2) and "Reading a work unit". Link it from
    `docs/README.md` and `docs/dispatch-and-backlog.md`. Add the `wu_` format and the four
    carrier names to `docs/agent-guides/change-contracts.md` as names that must not change.

## Data, API and compatibility

- The column is additive. An older database opens and upgrades, and an older build ignores
  the column.
- Every new input is optional, so an older MCP client and a newer daemon still agree.
- No public surface accepts a caller-chosen id. The supplied-id source is internal only. It
  exists for the later Agent Platform handoff (plan section 8).
- Write-once is enforced in SQL, not only in the caller.

## Tests and verification

- `test/work-unit-id.test.ts`: the pattern equals Agent Platform's; a known ULID vector
  (time 1469918176385 encodes to `01ARYZ6S41`); length; many mints are distinct and all
  match.
- Database: a schema-36 fixture gains the column and index and reopens; a second write with
  a different value keeps the first; a null value can be set once.
- Creation, one case per row of the plan's inheritance table: a plan session's task
  inherits; a ship session's does not; `"inherit"` from a ship session does; `"inherit"`
  with no task is refused; `"new"` from a plan session mints; a plan created by a plan and
  its own child all share one; retro follow-up; chat retry; ensemble members are equal; a
  parent with no id gets one when a child inherits; dispatch and assign each give an older row an id;
  requeue keeps it; a recovered creation keeps it; a resident run's task has none, at
  creation and after dispatch; a task created from a resident's session gets a new one, and
  `"inherit"` from it is refused.
- MCP, in process: the `create_task` result, `get_task` and `list_tasks` carry the field;
  the filter returns exactly one unit's tasks; a malformed filter value is refused.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## Merge and exit criteria

- A task created by a plan task's session has the plan task's `workUnitId`, with no change
  to any skill.
- A task created any other way has its own, with these exceptions, which are the rules of
  steps 5 to 8: a retro follow-up and a retried chat take their source task's; best-of-N
  members, their retries and a replacement share one for the run; a caller that passed
  `"inherit"` gets its own task's; and a resident run has none.
- No write changes an id once set.
- An existing database upgrades and its tasks read `workUnitId: null` until dispatched or assigned.
- No launch environment, exported payload or dashboard markup differs from before.

## Handoff

Later phases may rely on:

- `Task.workUnitId`, set for every task created, dispatched or assigned after this phase, except a
  resident run's, which is always null.
- The constants and `isWorkUnitId` in `src/shared/work-unit.ts`.
- `src/server/work-unit.ts` as the home for server-side work unit helpers.

They must not mint or copy an id anywhere but `TaskManager`, respell a carrier name, or
add a way for a request body to choose an id.

## Cross-phase audit

- Phase 2: adds `launchWorkUnitId` and `sessionWorkUnitId` to `src/server/work-unit.ts` and
  `workUnitId` to `TaskSummary`. This phase leaves them alone, so there is no overlap.
- Phase 3: reads the id at capture through Phase 2's launch record. Nothing here writes
  telemetry.
- Phase 4: reads `task.workUnitId` at the dispatch seam. No change needed here.
- Source plan: owns R1, D1, D3 and the record half of D6, and defines the names for R2.
- Plan validation repair, round 1: the exit criterion now lists every automatic inheritor, and
  a resident run has no work unit.
- Inspector review of the plan's pull request: an older row gets its id at assign as well as
  at dispatch, because Phase 2's reuse guard compares it with the work unit an agent was
  started with.
