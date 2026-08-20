# Phase 1: Rank the backlog

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)
Direct prerequisites: none (beyond the planning session's own pull request)

## Outcome

The backlog has **one order, and it is the operator's**. A `backlog_rank` on the task row
decides where every item sits, in the column and in the scheduler alike. Foreman takes the
highest ready item in that order. Work that files itself arrives at the bottom.

The phase ships a complete, user-visible feature: **Move up / Move down / Move to top / Move
to bottom** on every backlog card, reachable from the keyboard. Phase 2 adds dragging on top of
the same route. Nothing here is a dead surface waiting for phase 2 to give it a caller.

## Entry criteria

- `plan.md`'s four decisions are resolved (they are - see its **Decisions taken** section).
- Nothing else. This phase owns the column, the comparator, the route and its first caller.

## Scope

1. `tasks.backlog_rank` column, its index, and the one-time backfill.
2. `Task.backlogRank` on the wire.
3. `byBacklogRank`, and `backlogTasks` sorting by it.
4. `readyBacklog` reduced to filter-only; the stored plan supplies edges, not position.
5. Rank allocation (`src/server/backlog-rank.ts`) and rank assignment on task creation.
6. `POST /api/tasks/:id/reorder` and its client.
7. The four move controls on `BacklogColumn`'s card.
8. The copy that currently states plan-entry order as the rule in force.
9. Docs, tests, and one e2e spec.

### Non-goals

- **Dragging.** Phase 2 owns every drop target, drag-state and drop-indicator change.
- Any bulk re-sort, including a "Sort by priority" button - out of scope in `plan.md`.
- Changing the assign path's scan. It is **kept**; this phase documents it and pins it in a test.
- Teaching the planner prompt about rank.

## Repository findings

Verified against the current checkout. Where a finding contradicts `plan.md`, the finding wins.

- **There is no backlog table.** A backlog item is a `Task` with `status = 'backlog'`. All
  ordering is in-memory; the SQL only ever orders by timestamps
  (`db.ts` (`listTasks` `listTasks()` is `ORDER BY created_at DESC`).
- **`backlogTasks` (`src/shared/session.ts`) is the single chokepoint.** The board column,
  `ReportPanel`, `App.tsx`'s `visibleBacklog`, `line-summary.ts`, `report.ts`,
  `foreman/config.ts`, `plannableBacklog` and `readyBacklog` all read through it. One edit moves
  every surface together.
- **`readyBacklog` (`src/shared/backlog.ts`) ends with**
  `.filter((t) => blockersIn(t, index).length === 0)`. Every ready item therefore has zero unmet
  edges, so the ready set has no internal edges and any total order over it is dependency-safe.
  This is the fact the whole phase rests on - pin it with a test rather than a comment.
- **`topoOrder`'s doc comment in `backlog-plan.ts` already documents the plan's order as "a READOUT more than a
  schedule."** Removing the plan-walk from `readyBacklog` does not contradict that comment; it
  completes it. Update the comment to say what now decides position.
- **`sanitizePlan` still emits `topoOrder`.** Leave it. The stored entry order stops being read
  for position but remains a coherent readout, and `NextUpPlanner` still quotes each entry's
  `reason`. Do not delete the ordering from the writer in this phase; that is churn with no
  reader change behind it.
- **Migrations are idempotent and re-run on every open** (`migrate(d)`, `db.ts` (`migrate`).
  `addColumn` (`db.ts`) returns `true` **only when it actually added the column**, which is
  the repo's established hook for a one-time backfill - `migrateTaskHomeName` (`db.ts`) is
  the worked example to follow.
- **The task upsert is one long positional `INSERT ... ON CONFLICT DO UPDATE`**
  (the `INSERT INTO tasks ... ON CONFLICT` statement in `db.ts`). Adding a column means editing the column list, the `VALUES` placeholder
  count, the `DO UPDATE SET` list and the positional `.run(...)` arguments - four places that
  must stay in step. `rowToTask` (`db.ts`) is the read side.
- **`Registry.listTasks()` returns Map insertion order, unsorted** (`registry.ts` (`Registry.listTasks`), and
  `GET /api/tasks` serves it raw. Ordering is a predicate concern, not a route concern - so the
  route needs no `ORDER BY` and the Foreman worker gets the new order for free through
  `backlogTasks`.
- **The Foreman worker never opens SQLite.** It reads `GET /api/tasks` over loopback
  (`foreman/client.ts`) and decides with the shared predicates. Once `backlogRank` is on the
  wire, the worker needs **no change at all**.
- **Every automatic creator already funnels through `TaskManager.create`** with `backlog: true`:
  `task-sources/ingest.ts` (`ingestSweep`, `schedules/manager.ts`, `retro.ts`,
  `ensembles/member-launch.ts`, `ensembles/finalize-deps.ts`, and `POST /mcp/tasks`
  (`routes.ts` (`POST /mcp/tasks`). Assigning the rank in `create` therefore covers "synced items go to the
  bottom" for all of them with one edit and no per-caller work.
- **`reschedule` (`tasks.ts`) reuses the same row**, setting `status` back to `backlog`. It
  is not a new task, which is why the plan says a re-entering task keeps the rank it has.
- **`isAnnotationOnlyUpdate` (`protocol.ts`) counts patch keys** and must not learn about
  rank: rank does not travel on `UpdateTaskSchema` at all.

## Implementation steps, in execution order

### 1. `src/shared/types.ts` - the field

Add to `Task`:

```ts
/**
 * Where this item sits in the backlog, ascending - the operator's order and the only one.
 *
 * NULL means unranked, which sorts LAST: a row written by an older daemon, or one that
 * predates the backfill. Meaningful only while `status === "backlog"`; it is left alone
 * rather than nulled on any other status, so a task that comes back keeps its place.
 */
backlogRank: number | null;
```

### 2. `src/server/db.ts` - column, index, backfill, persistence

In `migrate(d)`, beside the `priority`/`labels`/`enabled` block near line 2837:

```ts
if (addColumn(d, "tasks", "backlog_rank", "INTEGER")) backfillBacklogRank(d);
d.exec("CREATE INDEX IF NOT EXISTS idx_tasks_backlog_rank ON tasks(status, backlog_rank)");
// NOT gated on the addColumn return: the backfill runs once, but a row can go NULL - or
// out of range - long after it. See "Why a degenerate rank space must be repaired rather
// than tolerated" below.
if (rankDegenerate(d)) normalizeBacklogRanks(d);
```

The index goes in `migrate`, never in the `CREATE TABLE` block - that block does not run on an
existing database, which is the exact trap the change contract names.

`backfillBacklogRank(d)` numbers today's backlog in **`byPriorityThenAge` order** so upgrade day
changes nothing visible, spaced by `RANK_STEP`. Express the priority rank as a SQL `CASE` that
mirrors `PRIORITY_RANK`/`UNSET_RANK` from `src/shared/task.ts` exactly - `blocker` 4, `high` 3,
`med` 2, unset 1, `low` 0 - and order **descending** by it, then ascending by `created_at`:

```sql
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY CASE priority
               WHEN 'blocker' THEN 4 WHEN 'high' THEN 3 WHEN 'med' THEN 2
               WHEN 'low' THEN 0 ELSE 1 END DESC,
             created_at ASC, id ASC
  ) AS n
  FROM tasks WHERE status = 'backlog'
)
UPDATE tasks SET backlog_rank = (SELECT n FROM ranked WHERE ranked.id = tasks.id) * 1024
WHERE id IN (SELECT id FROM ranked);
```

Guard the `CASE` with a comment pointing at `PRIORITY_RANK`, because it is a hand-copy of a
TypeScript table into SQL and nothing else will notice them drifting. A test asserts the two
agree.

Then thread the column through the upsert (**column list, placeholder count, `DO UPDATE SET`,
and the positional `.run(...)` args - all four**) and through `rowToTask`. Read it defensively, and validate rather than cast:
`Number.isSafeInteger(r.backlog_rank) ? r.backlog_rank : null`. `typeof === "number"` is not
enough - a REAL, a fraction and `NaN` all satisfy it, and each would poison the allocator's
arithmetic. Anything rejected reads as unranked, which `normalizeBacklogRanks` then places -
and note that this read-path check does not protect the allocator, which asks `rankDegenerate`
of the column directly. See the append-ceiling note.

### 3. `src/shared/task.ts` - the comparator

```ts
export function byBacklogRank(a: Task, b: Task): number {
  const ar = a.backlogRank ?? Infinity;
  const br = b.backlogRank ?? Infinity;
  if (ar !== br && Number.isFinite(ar - br)) return ar - br;
  if (ar !== br) return ar === Infinity ? 1 : -1;
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
```

Total on purpose. `Infinity - Infinity` is `NaN`, and a comparator that returns `NaN` sorts
unpredictably - which is why the two unranked rows fall through to `createdAt`, then `id`. Two
rows can genuinely share a rank (a restored backup, a hand-edited database), and a comparator
returning `0` there would let cards swap places between renders for no visible reason.

Leave `byPriorityThenAge` exported. Its **only** remaining caller is the migration backfill's
test; annotate it as such so a later reader does not think it still orders anything.

### 4. `src/shared/session.ts` - the chokepoint

`backlogTasks` sorts by `byBacklogRank`. One line. Everything downstream follows.

### 5. `src/shared/backlog.ts` - the plan stops deciding position

```ts
export function readyBacklog(tasks: Task[], plan: BacklogPlan | null): Task[] {
  const index = backlogIndex(tasks, plan);
  return backlogTasks(tasks)
    .filter((task) => task.enabled && taskKindAllowsBacklog(task.kind))
    .filter((task) => blockersIn(task, index).length === 0);
}
```

`plan` stays a parameter and stays load-bearing - `backlogIndex` reads it for the inferred edges
every blocker question is asked against. Rewrite the doc comment to say the new rule and **why
dropping the plan-walk is safe**: a ready item has no unmet edge, so the ready set has no
internal edges. Update `plannableBacklog`'s comment too - its 400-item head is now the top 400
**by rank**, which is a genuine improvement worth stating.

### 6. `src/server/backlog-rank.ts` - allocation

New file. Pure functions plus small `DatabaseSync`-taking helpers, no manager state.

- `RANK_STEP = 1024`.
- `MAX_RANK = Number.MAX_SAFE_INTEGER - RANK_STEP` - the append ceiling.
- `rankDegenerate(d)` - true when the backlog's rank space cannot be appended to safely: **any**
  `status='backlog'` row has a NULL rank, a non-safe-integer rank, or `max(backlog_rank)` is
  above `MAX_RANK`. One `SELECT`, no writes.
- `normalizeBacklogRanks(d)` - rewrite **every** backlog row's rank to `(i + 1) * RANK_STEP` in
  `byBacklogRank` order. Returns the ids it touched so the caller can publish a `task_upsert`
  for each. This is the single repair: it heals unranked rows, discards unsafe ones, and resets
  the ceiling in one pass.
- `appendRank(d)` - `if (rankDegenerate(d)) normalizeBacklogRanks(d)` **first**, then
  `max(backlog_rank) + RANK_STEP` over `status='backlog'`, or `RANK_STEP` when the backlog is
  empty. After normalization `max` is `count * RANK_STEP`, so the append is always safe.
- `rankBetween(before, after)` - the midpoint; `null` when there is no integer strictly between
  them, which is the caller's signal to normalize.

There is **one** repair operation, deliberately. An earlier draft of this plan had two - a
targeted "heal the NULLs" and a separate ceiling renormalize - and they raced: both were
specified to run "first" inside `appendRank`, and healing places unranked rows *below* every
ranked row, which means **above** the current maximum. So on a backlog holding both an
out-of-range rank and a NULL row, healing would compute `unsafe max + RANK_STEP` and write more
unsafe values before the ceiling check ever ran. Collapsing them removes the ordering hazard
rather than documenting it, and costs nothing: `byBacklogRank` already sorts NULLs last, so a
full renormalize *is* a heal - the unranked rows sort to the end and receive the highest ranks,
which is exactly where an unplaced arrival belongs.

#### Why a degenerate rank space must be repaired rather than tolerated

An unranked row is not a harmless row that "sorts to the bottom". It **breaks the
bottom-insertion rule for every task filed after it**:

1. `byBacklogRank` sorts `NULL` as `Infinity`, so an unranked row sits last.
2. `appendRank` hands the next arrival `max(backlog_rank) + RANK_STEP`, which is **finite**.
3. Finite sorts above `Infinity`, so that arrival lands *above* the unranked row - second to
   last, not last.

So one unranked row silently demotes itself below everything that comes after it, which is the
opposite of what the plan promises. The backfill cannot repair this on its own: it is hung off
`addColumn`'s did-it-add return and therefore runs exactly once, so a row that goes NULL *after*
the migration stays NULL forever.

Degenerate rows are reachable in practice. Any writer that does not set the column produces a
NULL - an older build opening a newer database (the migrations are idempotent, so this is
supported), a restored or hand-edited row, a future insert path that forgets the field. The same
routes can produce an out-of-range or fractional rank.

`rankDegenerate` + `normalizeBacklogRanks` therefore run in **two** places, and both are
`SELECT`-only no-ops once the backlog is clean:

- **In `migrate()`, unconditionally** - not gated on `addColumn`'s return, because the backfill
  runs once and a row can go degenerate long after it.
- **Inside `appendRank`'s transaction, before it reads `max`** - so a row that appeared *since*
  startup is repaired first, closing the window the migration-time pass cannot see.

The system therefore **converges to a clean rank space**, and the comparator's `NULL` branch
becomes a pure safety net for a row observed mid-repair rather than a state the ordering rules
depend on.

#### The append ceiling, and which limit actually binds

`appendRank` is the only operation that raises the maximum rank - a midpoint is strictly between
two existing values, and normalization compacts to `count * RANK_STEP` - so the ceiling is only
ever approached one `RANK_STEP` at a time, and it drops whenever the top-ranked task leaves the
backlog.

**Organic growth cannot reach it.** At `RANK_STEP = 1024` it takes ~8.8e12 appends to reach
`Number.MAX_SAFE_INTEGER`, which is ~24 million years at a thousand task creations a day. The
guard is therefore not for the counter running up; it is for a rank that arrives from **outside
the allocator**, which is the reachable case: a restored backup, a hand-edited row, or a future
writer that sets the column itself.

**The binding limit is `Number.MAX_SAFE_INTEGER` (2^53-1), not SQLite's signed 64-bit range.**
`Task.backlogRank` crosses the wire as a JSON `number`, so integer precision is lost at 2^53
while SQLite is still storing exact integers - about a thousandfold earlier. A guard placed at
the int64 boundary would be guarding a limit that cannot be reached without having already
silently corrupted the ranks it was meant to protect.

**Validation has to live on the write path, not only the read path.** `rowToTask` mapping an
unsafe value to `null` protects what the daemon *serves*; it does nothing for the allocator,
which reads `max(backlog_rank)` **in SQL** and never passes through `rowToTask`. That is why
`rankDegenerate` asks its question of the column directly. `normalizeBacklogRanks` then orders
through the same validated mapping the wire uses - an unsafe rank reads as unranked and sorts
last - so the read path and the write path cannot disagree about what a rank is.

### 7. `src/server/tasks.ts` - assignment and the move

- **On create**: when the task lands in `backlog` and has no rank, `appendRank`. This is the one
  edit that makes every automatic filer - sweeps, schedules, retro follow-ups, ensembles, MCP -
  arrive at the bottom. Do not touch the individual callers.
- **On re-entering the backlog** (`reschedule`, restart recovery): keep an existing rank;
  `appendRank` only when there is none.
- **`TaskManager.reorder(id, body)`**: resolve the anchor, compute the placement, renormalize and
  retry once if `rankBetween` returned `null`, persist, publish, return the updated `Task`. All
  of it in **one transaction**, so two dashboards dragging at once each produce a real ordering
  and never a half-applied one.

### 8. `src/shared/protocol.ts` + `src/server/routes.ts` - the route

```ts
export const ReorderTaskSchema = z.discriminatedUnion("position", [
  z.object({ position: z.literal("top") }),
  z.object({ position: z.literal("bottom") }),
  z.object({ position: z.literal("before"), anchorTaskId: z.string().min(1) }),
  z.object({ position: z.literal("after"),  anchorTaskId: z.string().min(1) }),
]);
```

An anchor, not an index: an index is a claim about a list the caller last saw, and the daemon's
list has moved on. `POST /api/tasks/:id/reorder` beside its siblings around `routes.ts` (beside `POST /api/tasks/:id/cancel`,
returning the updated `Task` on 200 like `dispatch`/`assign`/`complete`.

| Code | When |
|---|---|
| `404` | no such task, or no such anchor |
| `409` | the task is not in the backlog, the anchor is not in the backlog, or the anchor is the task itself |
| `200` | the updated `Task` |

The 409s matter: a card that dispatched between the click and the request is a state conflict the
operator can see, not a silent no-op.

### 9. `src/web/lib/api.ts` + `BacklogColumn.tsx` - the first caller

`api.reorderTask(id, body)` beside `updateTask` (`api.ts` (beside `updateTask`).

Four controls on the card. They are ordinary focusable `<button>`s with `aria-label`s naming the
task - `Move "Fix the flaky test" to top` - because the app selects by role and label and
**never** by `data-testid`.

Two hazards the existing card already teaches, both visible on the priority `<select>` in `BacklogColumn.tsx`:

- The card is `draggable`, so a control inside it must `stopPropagation` on **`mousedown`** or
  the browser starts a drag instead of activating the control.
- The card is click-to-edit, so it must `stopPropagation` on **`click`** too, or the move opens
  the dispatch modal on the way past.

Follow `setEnabled`'s pattern: nothing optimistic, re-render off the next snapshot, and surface a
refusal through `onAssignError` - a control that silently sprang back would look broken rather
than late. Disable `Move up`/`Move to top` on the first card and their opposites on the last.

### 10. Copy that stops being true

- `BacklogDrawer.tsx` - decision 1 of its header comment states plan-entry order as the rule
  in force. Rewrite it for rank order.
- `NextUpPlanner.tsx` - its rule-in-force comment says "`readyBacklog` walks Foreman's plan first". Rewrite. The head row is
  now the head **because that is where the operator put it**; the planner's `reason` is still
  worth quoting, for why the *dependencies* are what they are, but it is no longer the answer to
  "why this one first".
- `src/web/lib/backlog-copy.ts` - `plannerFacts` and its ready-band note make the same two claims.
- The doc comments in `src/shared/backlog.ts` and on `topoOrder` in `backlog-plan.ts`, as above.

### 11. Docs

Same change, not a follow-up:

- `docs/dispatch-and-backlog.md` - the priority table's **Sorts** column is now wrong. Priority
  no longer sorts anything; say what it does (colour, filter, triage signal) and say plainly that
  a swept `P0` arrives at the bottom.
- `docs/work-queues.md` - the autopilot section's ordering sentences, including the
  degraded-planner "oldest first" fallback, which is now "top-ranked first".
- `docs/foreman.md` - where it describes what the planner's order decides.

## Tests

- `test/backlog-rank.test.ts` (new) - `appendRank` on an empty and a populated backlog;
  `rankBetween` midpoint, and `null` for adjacent integers; `normalizeBacklogRanks` preserving
  order;
  `byBacklogRank` with nulls, ties, and the full tie-break chain; and **no `NaN`** from two
  unranked rows.
- `test/backlog-rank.test.ts` - **`byBacklogRank` is a strict total order**, asserted as a
  property rather than by example, over a fixture covering `null`, negative, zero and very large
  ranks with duplicate `createdAt`: antisymmetric, transitive, never `NaN`, and never 0 for two
  distinct rows. Assert explicitly that **a ranked row sorts before an unranked one whatever
  their `createdAt`** - the mixed case is the one an intuitive single-subtraction comparator gets
  backwards, and a by-example test that happens to use a younger unranked row would pass anyway.
- `test/backlog-rank.test.ts` - **the append ceiling.** With a backlog row seeded at
  `MAX_RANK + 1` (as a restored or hand-edited row could be), `appendRank` normalizes and the
  new task still lands last with a safe-integer rank. **And the combined case the single
  operation exists for:** an out-of-range ranked row *and* a NULL row in the same backlog, where
  a repair that healed before checking the ceiling would write a second unsafe value. Plus `rowToTask` mapping a REAL, a
  fraction, `NaN` and an out-of-safe-range integer to `null` rather than passing them through.
- `test/backlog-rank.test.ts` - **the unranked-row regression, stated as the rule it protects.**
  Insert a backlog row with `backlog_rank IS NULL` (as an older build would), then file a new
  task: the new task must sort **below** it, not above. Also: `normalizeBacklogRanks` places
  unranked rows below every ranked row, `rankDegenerate` is false on a clean backlog and true for
  each of NULL / non-safe-integer / above-`MAX_RANK`, and no NULL-ranked backlog row survives.
  Assert the same through `migrate()` on a database that already has the column but a NULL row in
  it - the case the one-shot backfill cannot see.
- `test/backlog-plan.test.ts` (extend) - the load-bearing invariant: over a table of backlogs and
  plans, every task `readyBacklog` returns has zero unmet edges, so no ready pair can be ordered
  by a dependency. Plus: a reorder does not change `planStale`.
- `test/backlog-machine.test.ts` (extend) - dispatch takes the top-ranked ready item; reordering
  changes which item is dispatched with **no replan**; and the assign path's exception is pinned
  as kept - a lower ready item with a matching free agent is assigned ahead of a head that has
  none.
- `test/task-triage.test.ts`, `test/task-triage-render.test.ts` (extend) - `backlogTasks` orders
  by rank; the column still does not sort for itself.
- `test/backlog-reorder-http.test.ts` (new) - through `buildApp`: 404 missing task, 404 missing
  anchor, 409 dispatched task, 409 dispatched anchor, 409 self-anchor, 200 returning the moved
  task, and the placement surviving a reopen.
- Migration coverage (extend the existing db tests) - the backfill runs **exactly once**, orders
  by `byPriorityThenAge`, an already-migrated database is not renumbered on the next open, and
  **the SQL `CASE` agrees with `PRIORITY_RANK`** for every priority including unset.
- Task-creation coverage (extend) - a swept task, a scheduled task and an MCP-created task each
  land at the bottom; a rescheduled task keeps its rank.
- `e2e/specs/backlog-reorder.spec.ts` (new) - file three backlog tasks, move the third to the top
  **with the keyboard**, and confirm the board column, the Line drawer and the `next up` mark all
  agree. Then let autopilot launch and confirm it took the one that was moved up. Spend no model
  tokens: every agent binary is faked by `e2e/fixtures/fake-agents.ts`.

### Verification

```sh
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
npx playwright install chromium   # once per machine
npm run test:e2e
```

A single test file needs the suite's loader:
`node --test --import ./test/setup-state.mjs --import tsx test/backlog-rank.test.ts`.

## Merge and exit criteria

- All of the above green; `npm run test:e2e` included, because UI surfaces changed.
- Reordering with the keyboard changes what Foreman schedules next, proven in the browser.
- A database that predates the column opens, backfills once, and shows the order it showed before.
- A swept task arrives at the bottom - including when an unranked row is already sitting there.
- No `status='backlog'` row is left with a NULL rank after a daemon start.
- Every rank the daemon writes is a safe integer, and a row carrying anything else is re-placed
  rather than trusted.
- Docs match the implementation - no surface still claims priority sorts the backlog.

## Downstream handoff

Phase 2 may rely on, and **must not change**:

- `POST /api/tasks/:id/reorder`, its `ReorderTaskSchema` shape, and its 404/409/200 contract.
  Phase 2 adds a caller, not a route.
- `api.reorderTask` as the only client entry point.
- `Task.backlogRank`, `byBacklogRank`, and `backlogTasks` sorting by it.
- `readyBacklog` as filter-only.
- The move buttons and their `aria-label` wording, which the phase-1 e2e spec selects by.
- `RANK_STEP`, `MAX_RANK`, and the allocation semantics: a collision normalizes rather than
  failing, and `appendRank` repairs a degenerate rank space **before** it reads `max`, through
  the single `normalizeBacklogRanks` operation rather than a heal and a renormalize that could
  order badly against each other.

Phase 2 owns, and phase 1 must not pre-empt: any drop target, drag-state, drop-indicator or
`dragover`/`dragleave`/`drop` handler in `BacklogColumn`, and the CSS for them. Phase 1 leaves
`draggable` and the existing `onDragStart`/`onDragEnd` on the card **exactly as they are today**.

## Cross-phase audit record

- **Initial (this phase):** owns the schema, the wire field, the comparator, the route and the
  keyboard caller. Deliberately ships a complete feature rather than a foundation, so that a
  stalled phase 2 leaves reordering usable rather than leaving a route with no caller.
- **After phase 2 was written:** confirmed phase 2 adds only drop targets and drag state, and
  consumes the phase-1 route unchanged. No phase-1 decision needed moving. The one contract made
  explicit in response was the "phase 1 leaves `draggable` and `onDragStart` untouched" line in
  the handoff above, so the two phases cannot both edit the same drag setup.
