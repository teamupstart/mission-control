# Phased plan: Manual backlog order

Source plan: [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html))

## The approved goal

Drag a backlog item above another and Foreman takes it first; drag it down and it takes it
later - unless it is waiting on a dependency. Work that files itself (a task source sweep, a
recurring mission, a retro follow-up, an MCP `create_task`) lands at the **bottom**.

## Human decisions, incorporated as requirements

All four were submitted at plan review and are written into `plan.md`'s **Decisions taken**
section. They are requirements here, not open questions.

| Decision | Taken | Owned by |
|---|---|---|
| Priority vs manual order | **Rank is the only order. Priority is pure annotation.** No bulk "Sort by priority" button - explicitly out of scope. | Phase 1 |
| The reorder gesture | **Drag in the column, plus keyboard move controls.** | Keyboard: Phase 1. Drag: Phase 2. |
| The assign path's scan | **Kept.** Dispatch takes the head; assign may take a lower ready item that has a free agent. | Phase 1 (documented and pinned in a test) |
| Rank allocation | **Sparse integers, renormalize on collision.** | Phase 1 |

The first decision carries an accepted cost, stated rather than mitigated: **a swept `P0` now
lands at the bottom until somebody moves it.** `plan.md` argues why.

## What the investigation found

Verified against the checkout before the boundaries were drawn. Two findings shaped the split.

1. **`backlogTasks` (`src/shared/session.ts`) is a single chokepoint.** The board column, the
   Sitrep, the Line drawer, `line-summary.ts`, `report.ts`, `foreman/config.ts`,
   `plannableBacklog` and `readyBacklog` all read through it. Changing one comparator moves every
   surface together, and none of them can drift apart.
2. **`readyBacklog` already drops every item with an unmet dependency**, so a ready item has zero
   unmet edges and the ready set has no internal edges. Any total order over it is
   dependency-safe. That is why replacing the model's order with the operator's is a deletion
   rather than a new sort - and it is pinned as an invariant test rather than left as a comment.

Three findings that contradicted or sharpened the source plan, and are resolved in the phase
files rather than left to be rediscovered:

- **The Foreman worker needs no change at all.** It never opens SQLite; it reads `GET /api/tasks`
  over loopback and decides with the shared predicates. Once `backlogRank` is on the wire it gets
  the new order for free.
- **Every automatic filer already funnels through `TaskManager.create`** with `backlog: true`, so
  "synced items go to the bottom" is one edit in one place, not one per source.
- **The task upsert is a positional `INSERT ... ON CONFLICT`** with four lists that must stay in
  step (columns, placeholders, `DO UPDATE SET`, `.run` args). Named in phase 1 because three of
  the four are easy to miss.

## Sizing, and why two phases

**Estimate: 420-520 gross non-test implementation lines**, counting all layers together.
Assumptions: ~260 server and shared (migration and backfill ~40, the upsert and row mapper ~10,
types and comparator ~30, `readyBacklog` and its comments ~30, `backlog-rank.ts` ~80, the manager
and route ~70), and ~220 browser (drag ~120, move controls ~45, CSS ~30, copy ~25). Documentation
and tests are excluded from the count and included in the phases. It is a planning signal, not a
promised diff size.

That is above the 200-line one-phase threshold, so the default is still **one** phase and a
second needs a case. The case:

- **The riskiest work is cleanly separable.** The drag change adds a second kind of drop target
  for a payload that already means "assign this to an agent". Getting it wrong breaks a gesture
  that works today, and it is the part with the largest e2e surface and the least deterministic
  test story.
- **The boundary is a real merge boundary, not a layer boundary.** Phase 1 is a complete,
  user-visible feature on its own: the backlog has one order, Foreman honours it, and you can
  reorder it from the keyboard. It leaves no dead surface waiting for phase 2 - the route has a
  caller the moment it lands. Phase 2 is additive.
- **Combining them would be worse.** One task carrying a migration with a hand-written SQL
  backfill, a semantics change in the hottest shared predicate, a new allocator, a new route and
  a drag-and-drop rework is a large ask for one session, and a failure in the drag work would
  hold back the ordering semantics that everything else in the plan depends on.

Both decisions on the gesture are still delivered - `plan.md` chose drag **and** keyboard, and
between the two phases both ship.

Nothing smaller was created. There is no preparation phase, no test-only phase and no
documentation phase: docs, tests and copy changes live with the behaviour that makes them true.

## Phases

| # | Phase | Delivers | Direct prerequisites |
|---|---|---|---|
| 1 | [Rank the backlog](phase-1-rank-the-backlog.md) | `backlog_rank` column and backfill, the comparator, `readyBacklog` reduced to filter-only, the allocator, `POST /api/tasks/:id/reorder`, the keyboard move controls, docs | none |
| 2 | [Drag to reorder](phase-2-drag-to-reorder.md) | Drop targets between cards, drag state, the drop indicator, and the regression proof that drag-to-assign still works | Phase 1 |

## Dependency graph

```
planning session PR (publishes these artifacts)
        |
        v
    Phase 1  --->  Phase 2
```

**Concurrency groups:** none. The graph is serial - phase 2 consumes phase 1's route, client and
comparator, so there is nothing that can run alongside it. Every task also depends on this
planning session, whose pull request publishes the paths the tasks name.

**Merge order:** planning PR, then phase 1, then phase 2.

## Cross-phase contracts

Fixed by phase 1, consumed unchanged by phase 2:

- `POST /api/tasks/:id/reorder`, `ReorderTaskSchema` (`top` / `bottom` / `before` + anchor /
  `after` + anchor), and its 404 / 409 / 200 contract. **Anchors, never indices.**
- `api.reorderTask(id, body)` as the only client entry point.
- `Task.backlogRank: number | null`, `byBacklogRank`, and `backlogTasks` sorting by it.
- `readyBacklog` as filter-only; the stored plan supplies edges, never position.
- `RANK_STEP` and renormalize-on-collision.
- The move buttons' `aria-label` wording, which the phase-1 e2e spec selects by.

**Ownership boundary, stated because both phases could plausibly have claimed it:** phase 1
leaves `draggable` and the card's existing `onDragStart` / `onDragEnd` **exactly as they are
today**. Phase 2 owns every drop target, drag-state and drop-indicator change. Without this line
phase 1 would have touched the drag setup to stop the move buttons starting a drag, and phase 2
would have touched it to report the dragged id upward, and the two would have merged into a
conflict neither file predicted.

## Final verification

After phase 2 merges:

```sh
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
npm run test:e2e
```

The behavioural bar, proven in a browser rather than by reading a diff:

- Reordering - by keyboard **and** by drag - changes what Foreman schedules next.
- Dragging a card onto an idle agent still assigns it.
- A database that predates the column opens, backfills once, and shows the order it showed before.
- A swept task arrives at the bottom.
- Dependencies still gate: a blocked item dragged to the top runs first **when it unblocks**, and
  not before.
- No surface still claims priority sorts the backlog.

## Final cross-phase audit

- Every requirement in `plan.md` and every submitted decision is owned by **exactly one** phase.
  The gesture decision is the only one split across two, and deliberately: keyboard in phase 1,
  drag in phase 2, both required.
- Every consumer follows its prerequisite. Phase 2 → phase 1 only; there is no edge back, so
  phase 1 is shippable alone.
- No concurrent phases, so there is no merge-in-either-order claim to check.
- The final state matches `plan.md` with no undocumented cleanup: nothing in phase 2 repairs a
  knowingly broken state left by phase 1, because phase 1 ends operable.
- Items `plan.md` puts out of scope stay out of both phases: bulk re-sort, per-repo sub-orders,
  teaching the planner about rank, multi-select drag.
