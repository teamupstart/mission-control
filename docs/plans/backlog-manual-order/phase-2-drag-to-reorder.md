# Phase 2: Drag to reorder

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)
Direct prerequisites: **Phase 1** ([`phase-1-rank-the-backlog.md`](phase-1-rank-the-backlog.md))

## Outcome

You can **drag a backlog card up or down the column** and it stays where you drop it. The same
drag still hands a card to an idle agent when you drop it on one - which drop target it lands on
decides which thing happens, with no handle, no modifier and no mode.

This is the gesture the feature was asked for. Phase 1 made it possible and gave it a keyboard
route; this phase makes it feel like a list.

## Entry criteria

Phase 1 merged, so the following exist on the default branch and are consumed unchanged:

- `POST /api/tasks/:id/reorder` with `ReorderTaskSchema` (`top` / `bottom` / `before` + anchor /
  `after` + anchor) and its 404 / 409 / 200 contract.
- `api.reorderTask(id, body)` as the only client entry point.
- `Task.backlogRank`, `byBacklogRank`, `backlogTasks` sorting by it, `readyBacklog` filter-only.
- The four move buttons and their `aria-label` wording.

## Scope

1. Drop targets **between** cards in `BacklogColumn`, and at the head and foot of the list.
2. The drag state the column needs to know which gap is live and which card is in the air.
3. A drop indicator, in `src/web/styles.css`.
4. Two e2e cases: drag-to-reorder, and drag-to-assign still working from the same drag.

### Non-goals

- Any change to the route, the schema, the allocator or the comparator. This phase adds a
  caller.
- Bulk / multi-select drag - out of scope in `plan.md`.
- Touch-specific or pointer-events reimplementation. HTML5 drag-and-drop is what the card and
  `SessionTile` already speak; introducing a second drag system to serve one column is the
  wrong trade.
- Reordering inside the Line's `BacklogDrawer`. Its ready band already follows rank through
  `readyBacklog`; giving a second surface its own drag gesture is its own change.

## Repository findings

- **The drag already exists and already means something.** `BacklogCard`
  (`BacklogColumn.tsx:214-230`) is `draggable`, sets
  `e.dataTransfer.setData("application/x-mission-task", task.id)` and
  `effectAllowed = "move"`, and calls `onDragging(repoRoot)` so the board can light up the tiles
  that could accept it. `SessionTile` (`SessionTile.tsx:132,143`) is the only drop target today,
  gated by `canAcceptTask` (`BacklogColumn.tsx:426`).
- **So this phase adds a second kind of drop target for the same payload.** No new MIME type: a
  second payload would mean the card has to decide at `dragstart` what the drag is *for*, which
  is exactly the mode this design avoids. The drop target decides.
- **`onDragging(null)` for a multi-repo task is load-bearing** (`BacklogColumn.tsx:227`): a
  multi-repo card announces no repo so no tile lights up, because those tasks are dispatch-only.
  **The column's own gaps must still accept it** - reordering a multi-repo task is fine, only
  assigning it is not. Do not gate the column's drop targets on the repo the card announced.
- **The column body is `div.board-col-body`** holding `tasks.map(...)` of `BacklogCard`
  (`BacklogColumn.tsx:106-120`), with a `board-col-empty` paragraph when the list is empty. The
  gaps are inserted into that map.
- **`tasks` arrives pre-sorted** from `App.tsx:1507` (`backlogTasks`, then the filter box). The
  column does not sort and must not start - `test/task-triage-render.test.ts:141` pins that.
  **Consequence:** when the filter box is narrowing the list, the card visually above another is
  not necessarily its neighbour in the real backlog. Anchoring on the **adjacent visible card's
  id** is still correct, because the route places relative to that anchor in the real list, which
  is what the operator pointed at.
- **`dragover` must call `preventDefault()`** or the browser refuses the drop - the same thing
  `SessionTile.tsx:132` already does.
- **`dragleave` fires when moving onto a child element**, which makes a naive
  `onDragEnter`/`onDragLeave` pair flicker. Keep the active gap in state keyed by the gap's
  index and set it on `dragover` rather than tracking enter/leave counts.

## Implementation steps, in execution order

### 1. Column drag state

`BacklogColumn` gains two pieces of local state: the id of the card being dragged (so it can be
dimmed and so a drop onto its own two adjacent gaps is a no-op) and the index of the gap
currently under the cursor.

`BacklogCard` already reports drag start and end upward through `onDragging`. Extend that path
rather than adding a parallel one - the column needs the **task id**, which `onDragging` does not
currently carry. Widen it, or add a sibling callback; either is fine, but there must remain
**one** notion of "what is in the air".

### 2. The gaps

Render a drop target before the first card, between every pair, and after the last. Each gap:

- `onDragOver` - `preventDefault()`, set `dropEffect = "move"`, mark itself active.
- `onDrop` - resolve to a `ReorderTaskSchema` body and call `api.reorderTask`.
- Accept only the drag this column is about: read the id from
  `"application/x-mission-task"` and ignore anything else.

Resolve each gap to the body that expresses it **without an index**:

| Gap | Body |
|---|---|
| above the first card | `{ position: "top" }` |
| between cards A and B | `{ position: "before", anchorTaskId: B.id }` |
| below the last card | `{ position: "bottom" }` |

`top` and `bottom` rather than `before`/`after` the current end cards, because the ends are the
one place a racing dashboard can change what "first" means between render and drop.

**A drop into either gap adjacent to the dragged card is a no-op** - it would move it to where it
already is. Return without a request rather than sending one that changes nothing.

An empty column keeps `board-col-empty`, and that paragraph becomes a single `bottom` target so
the first card can be dropped into an empty backlog.

### 3. The refusal path

Reuse `onAssignError`, exactly as the move buttons do. Phase 1's 409s are reachable here by
ordinary racing - a card that dispatched while it was in the air, or an anchor that did - and a
column that silently snapped back would look broken rather than late.

### 4. The indicator

In `src/web/styles.css`, beside the existing `.bl-card` rules (~line 24033). A gap is a thin
target with a generous hit area and no layout impact when idle - it must not shift the column as
the cursor moves, because a list that reflows under a drag is a list you cannot aim at. The
active gap draws a single line in the board's accent.

Dim the dragged card while it is in the air, so the drop looks like a move rather than a copy.

### 5. Tests

- `test/task-triage-render.test.ts` (extend) - the column renders one more gap than it has cards,
  and still does not sort its input.
- `e2e/specs/backlog-reorder.spec.ts` (extend the phase-1 spec) - **drag** the third card above
  the first with `page.mouse` and confirm the board column, the Line drawer and the `next up`
  mark all agree, and that the change survives a reload (it is on the row, not in the DOM).
- Same spec - **drag a card onto an idle agent tile** and confirm it still assigns. This is the
  regression that matters most: one drag now has two possible endings, and nothing else in the
  suite would notice the assign one breaking.
- Same spec - drop a card back into its own gap and confirm **no request is sent** and the order
  is unchanged.

Playwright drives HTML5 drag-and-drop through `dragTo`, or `mouse.down`/`mouse.move`/`mouse.up`
when a synthetic drag needs intermediate `dragover` events. Prefer whichever actually fires the
handlers; assert the resulting **order**, never the intermediate DOM.

### Verification

```sh
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
npm run test:e2e
```

Attach the drag-reorder and drag-assign frames to the pull request from
`e2e/.artifacts/backlog-reorder/`. That directory is gitignored - never commit evidence.

## Merge and exit criteria

- All of the above green, `npm run test:e2e` included.
- Dragging a card up the column moves it, and the move survives a reload.
- Dragging a card onto an idle agent still assigns it - proven in the browser, not by reading the
  diff.
- Dropping a card where it already is sends no request.
- A multi-repo card can be reordered even though no tile will accept it.
- The column does not reflow while a card is in the air.

## Downstream handoff

Nothing depends on this phase. It completes the feature.

What a later change must not quietly undo: the column's gaps and `SessionTile` share **one** drag
payload (`application/x-mission-task`) and one `dragstart`. Adding a third drop target means
adding a target, not a second payload or a mode - the moment two drags mean two different things,
the card has to know at `dragstart` which one is happening, and the gesture stops being one
gesture.

## Cross-phase audit record

- **Initial (written after phase 1):** re-read `plan.md`, its **Decisions taken** section, and
  `phase-1-rank-the-backlog.md`. This phase consumes phase 1's route, schema, client and
  comparator without modifying any of them.
- **Reconciliation with phase 1:** phase 1's handoff was amended while this file was written, to
  state that phase 1 leaves `draggable` and the existing `onDragStart`/`onDragEnd` on the card
  exactly as they are. Without that line both phases could plausibly have edited the same drag
  setup - phase 1 to keep the move buttons from starting a drag, phase 2 to report the dragged
  id upward - and merged into a conflict neither file predicted. Ownership now sits in exactly
  one phase.
- **Contract direction confirmed:** phase 2 → phase 1 only. There is no edge back, so phase 1 is
  mergeable and shippable on its own.
