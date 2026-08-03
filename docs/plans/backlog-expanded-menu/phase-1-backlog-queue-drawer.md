# Phase 1: the Backlog queue drawer

## Outcome

Clicking the BACKLOG stage on The Line opens a Backlog drawer in place - the fourth stage
drawer, beside Intake, Review, and Decide - instead of opening the Sitrep panel. The drawer
lists the backlog in the order autopilot would take it, marks the next task up, and carries
the triage actions that already have routes: launch now, park/resume, and an inline priority
select. Blocked and parked tasks are visible with their reasons, and the Sitrep keeps the
full-fleet read via a footer link.

## Entry criteria and dependencies

- `docs/plans/backlog-expanded-menu/plan.md` (the approved source plan, adopted decisions
  included) and this file are on the default branch.
- No other phase is a prerequisite. This is the foundation phase.

## Scope and non-goals

In scope:

- Retarget the BACKLOG stage click from the Sitrep to a new drawer.
- The `BacklogDrawer` body component, its styles, and an optional footer slot on the
  `LineDrawer` frame.
- Unit/render tests, Playwright specs, and README updates for all of the above.

Non-goals (owned by Phase 2 or out of scope entirely):

- The planner popover, its "why" content, and the autopilot readout/toggle (Phase 2).
- Any reordering concept beyond the inline priority select (adopted decision 2).
- Any change to the Sitrep panel, the Foreman planner, plan storage, or task routes.
- New keyboard shortcuts.

## Repository findings this phase builds on

Verified in the current tree; re-check on arrival:

- `src/web/lib/line-drawer.ts:27` - `LINE_DRAWER_STAGES = ["intake", "review", "decide"]`,
  with a comment stating a fourth drawer is "this list and a body component".
- `src/web/lib/line-targets.ts:36` - `backlog: { kind: "sitrep" }` in `LINE_STAGE_TARGETS`.
  `lineStageHasDrawer` reads off the table, so the flip advertises `aria-expanded` on the
  stage button with no strip change.
- `src/web/components/line/LineDrawer.tsx` - the frame: focus on open, `esc` via App, ✕,
  `aria-controls`/`LINE_DRAWER_DOM_ID`, and the body cap
  (`.line-drawer-body`, `min(38vh, var(--line-drawer-row-h) * 3)`). `DRAWER_GLYPHS` needs a
  `backlog` entry (`☰`, matching `LINE_STAGE_GLYPHS` in `LineStrip.tsx:29`).
- `src/web/App.tsx` - `onLineStage` (~:779) performs targets; drawers render between the
  strip and the layouts (~:2270-2299); `closeLineDrawer`, `registerLineStage`, and the
  route-change close effect all exist. App already holds `tasks`, `visibleBacklog`
  (~:985), and `foreman.backlogPlan` (via `useForeman`, 4s poll) - no new fetch on open.
- `src/shared/backlog.ts` - `backlogIndex` (build once per render), `blockersIn`,
  `readyBacklog` (plan-entry order, then unplanned tail; disabled and blocked excluded),
  `nextUpTaskId` (= `readyBacklog(...)[0]`), `deadBlockersFor`. `backlogTasks` in
  `src/shared/session.ts:39-40` sorts by `byPriorityThenAge`.
- Actions with existing routes and client wrappers (`src/web/lib/api.ts`):
  `dispatchBacklog(id, true)` → `POST /api/tasks/:id/dispatch`;
  `updateTask(id, { enabled })` and `updateTask(id, { priority })` →
  `POST /api/tasks/:id/update`. Shared leaves in
  `src/web/components/session-bits.tsx`: `ScheduleSwitch` (:1586) and `DeadBlockerButton`
  (:1675, reschedule / mark done on a dead prerequisite).
- The priority select pattern: `src/web/components/layouts/BacklogColumn.tsx:295-301`
  (`.bl-prio select`, `priority: next === "" ? null : next`).
- Tests that pin current behavior and change deliberately here:
  `test/line-drawer.test.ts:79-101` asserts
  `deepEqual([...LINE_DRAWER_STAGES], ["intake", "review", "decide"])` and that non-drawer
  stages never have `kind: "drawer"`.
- e2e conventions: `e2e/specs/line-drawers.spec.ts` - `stage()`/`drawer()` locators by role
  and accessible name, seeding through `POST /api/tasks` (`backlog: true`), parking through
  `POST /api/tasks/:id/update`, one daemon per test, `MISSION_POOL_REAP_MS=0`, no
  `data-testid`, never `{ exact: true }` on button names.

## Implementation steps

In execution order; each step names its files.

1. **Flip the seam.** `src/web/lib/line-drawer.ts`: append `"backlog"` to
   `LINE_DRAWER_STAGES`; update the "three of six" comment.
   `src/web/lib/line-targets.ts`: `backlog: { kind: "drawer", stage: "backlog" }`; rewrite
   the comment that currently explains the Sitrep choice to explain the drawer.
2. **Frame additions.** `src/web/components/line/LineDrawer.tsx`: add `backlog: "☰"` to
   `DRAWER_GLYPHS`; add an optional `footer?: ReactNode` prop rendered after
   `.line-drawer-body` inside the section (class `line-drawer-foot`). Existing drawers pass
   nothing and render unchanged.
3. **The body.** New `src/web/components/line/BacklogDrawer.tsx`, props: `tasks`,
   `backlogPlan`, `now`, `onClose`, `onEditTask`, `onOpenSitrep`. Derive once per render:
   `backlogIndex`, `readyBacklog`, `nextUpTaskId`, and the blocked/parked partition of
   `backlogTasks`. Render:
   - Ready rows in `readyBacklog` order: priority mark + title (button → `onEditTask`),
     kind/agent/age meta, the next-up marker pill on the head row, and actions - Launch now
     (`api.dispatchBacklog(task.id, true)`), park (`ScheduleSwitch`), inline priority select
     (BacklogColumn pattern).
   - Blocked rows: amber inset (`is-waiting` convention), blocker text from `blockersIn`
     ("waiting on <title>"), `DeadBlockerButton` when `deadBlockersFor` is non-empty.
   - Parked rows: dimmed, "parked" pill, Resume (`updateTask { enabled: true }`).
   - Head `count`: `N ready · N blocked · N parked` (omit zero segments); `attention` when
     `count > 0 && ready === 0` ("nothing ready").
   - Empty state (`LineDrawerEmpty`): backlog is empty; point at Intake and the dispatch
     modal by name, in the interface's voice.
   - Footer: `Sitrep →` button calling `onOpenSitrep` (the full-fleet read stays one click
     away).
4. **Render site.** `src/web/App.tsx`: render `BacklogDrawer` beside the other three when
   `lineDrawer === "backlog"`, passing `onOpenSitrep` that closes the drawer and sets
   `reportOpen` (the same effect the old stage click had). No other App state changes.
5. **Styles.** `src/web/styles.css`, in the Line drawer section (~:14500-14760): row
   internals for the backlog drawer (identity column reusing the shared 240px pattern,
   next-up spine `inset 2px 0 0 var(--purple)` per the mockup, priority select reusing
   `.bl-prio` conventions where sharable), and `.line-drawer-foot`. Keep
   `--line-drawer-row-h` at 58px so the Electron cap tests hold.
6. **Unit and render tests.** `test/line-drawer.test.ts`: update the exact-stages assertion
   to `["intake", "review", "decide", "backlog"]` and the target-table expectations; add
   `BacklogDrawer` markup projections (ready/blocked/parked rows, next-up marker, counts,
   attention copy, empty state, footer, accessible names), following the existing
   `createElement` + `renderToStaticMarkup` style.
7. **Playwright specs.** `e2e/specs/line-drawers.spec.ts`: Backlog opens a drawer and not
   the Sitrep; toggle/swap/`esc`/focus semantics match the other stages (`aria-expanded`,
   `aria-controls`, focus lands on the region); seeded ready/blocked/parked tasks render in
   the right bands with the next-up marker on the plan head; Launch dispatches (fake agent
   session appears); park flips and the row moves bands; priority select round-trips; the
   footer's Sitrep button opens the panel. Seed blockers via task `dependencies`.
8. **README.** Update the stage click table row (~:4292) to name the drawer; add the fourth
   row to the drawer table (~:4331) with its "Each row says" and "Escalates to" columns;
   fix the three-of-six arithmetic (~:4286); leave the `r` Roundup shortcut row untouched.

## Data, API, and migration notes

Nothing new. All mutations go through existing Zod-validated routes (`UpdateTaskSchema`,
`DispatchBacklogTaskSchema`); the drawer reads SSE task state and the existing `useForeman`
plan poll. No schema, storage, or protocol change. No migration.

## Tests and verification

- `npm run typecheck && npm run lint`
- `npm test` - expect `test/line-drawer.test.ts`, `line-strip-render`, both Electron
  geometry suites, and the backlog suites green.
- `npm run build && npm run test:e2e` - the updated `line-drawers.spec.ts` plus the
  existing specs.
- Runtime visual pass against mockup A (`docs/mockups/backlog-expanded-menu.html`) for
  spacing, tones, and cap behavior with more than three rows.

## Merge and exit criteria

- All checks above green; README matches behavior; no unrelated edits.
- The BACKLOG stage advertises `aria-expanded`, opens/toggles/swaps the drawer, and no
  path opens the Sitrep from the stage click.
- A reviewable PR whose merge releases Phase 2.

## Downstream handoff (what Phase 2 may rely on)

- `LINE_DRAWER_STAGES` includes `"backlog"`; `LINE_STAGE_TARGETS.backlog` is the drawer.
- `src/web/components/line/BacklogDrawer.tsx` exists with the props named above and renders
  the footer slot; the `LineDrawer` frame accepts `footer?: ReactNode`.
- The ready-row layout and class names are stable, with one exception Phase 2 owns: the
  next-up marker on the head row is a **static pill in this phase** and Phase 2 replaces
  that element with the planner trigger button. Nothing else in the row is Phase 2's to
  change.
- The footer contains the Sitrep button; Phase 2 adds the autopilot line beside it without
  moving the Sitrep button.

## Cross-phase audit record

- 2026-08-02: initial write. Contract with Phase 2 set: static next-up pill here, trigger
  there; footer slot introduced here, extended there. No conflicts to reconcile yet.
