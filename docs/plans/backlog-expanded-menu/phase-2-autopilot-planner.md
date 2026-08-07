# Phase 2: the autopilot planner

## Outcome

The Backlog drawer explains itself. The next-up marker becomes a trigger that opens an
anchored planner popover: the task autopilot would take next, the Foreman's own recorded
reason for planning it there, the computed facts (priority band, age, blocker status, how
many tasks it unblocks), and a Launch now button. The drawer's footer gains the autopilot
line: the live readout (`on/off · active/max · ready/blocked/disabled`) and a toggle bound
to the same `ForemanConfig.autoBacklog` the ForemanBar checkbox writes.

## Entry criteria and dependencies

- Direct prerequisite: **Phase 1** (the Backlog queue drawer) is merged. This phase renders
  inside `BacklogDrawer` and extends its footer.
- `docs/plans/backlog-expanded-menu/plan.md` and this file are on the default branch.

## Scope and non-goals

In scope:

- The planner popover component, its trigger (replacing Phase 1's static next-up pill), its
  dismissal behavior, and its styles.
- The autopilot readout and toggle in the drawer footer.
- Unit/render tests, Playwright specs, and README updates for both.

Non-goals:

- "Skip once" or any deferral concept (adopted decision 3: dropped; Park covers it).
- Any change to the Foreman planner algorithm, plan storage, or `readyBacklog` ordering.
- Autopilot settings beyond the `autoBacklog` boolean (mode, maxSessions, and the rest stay
  in ForemanBar).
- Changes to Phase 1's row layout other than the next-up marker element.

## Repository findings this phase builds on

Verified in the current tree; re-check on arrival:

- `BacklogPlanEntry` (`src/shared/types.ts:1552-1575`):
  `{ taskId, dependsOn: string[], reason: string | null }` inside
  `BacklogPlan { entries, note, generatedAt }`. The browser receives it via
  `useForeman.ts` polling `fetchBacklogPlan()` (`GET /api/backlog/plan`) every 4s; App
  passes it down already (Phase 1 consumes it in `BacklogDrawer`).
- Computed facts come from `src/shared/backlog.ts`: `nextUpTaskId`, `backlogIndex`, and -
  for "unblocks N tasks" - counting backlog tasks whose `blockersIn` include the featured
  task. Age from `task.createdAt` with `relativeTime` (`src/web/lib/format.ts`).
- Autopilot state: `ForemanConfig.autoBacklog` (`src/shared/protocol.ts:1059`, default
  false) written through `PUT /api/foreman/config`; the readout
  `status.autopilot { on, active, max, ready, blocked, disabled }`
  (`src/shared/types.ts:1225-1245`, filled at `src/server/foreman/config.ts:177-178`). The
  existing toggle UI is `ForemanBar.tsx:386-395`
  (`update({ autoBacklog: e.target.checked })`); `useForeman` exposes config, status, and
  the update path - reuse them, never a parallel state.
- Popover precedents (styles.css): `.launch-pop` (:4780), `.open-in-pop` (:2621,
  `role="menu"`), and the backlog-specific `.bl-deadblock-pop` (:16549) driven by
  `DeadBlockerButton` (`session-bits.tsx:1675`) - the closest model for a popover opened
  from a row, including outside-click and Escape dismissal that stops short of closing the
  surface under it.
- e2e can seed a plan with a reason: `PUT /api/backlog/plan` (`src/server/routes.ts:2636`)
  and read config back via `GET /api/foreman/config` (:2610) to assert the toggle
  round-trip.

## Implementation steps

1. **The trigger.** In `src/web/components/line/BacklogDrawer.tsx`, replace Phase 1's
   static next-up pill with a button (accessible name naming the task, e.g.
   `Next up: <title> - why and launch`), `aria-expanded`/`aria-haspopup` set, anchored
   container `position: relative` on the row.
2. **The popover.** New `src/web/components/line/NextUpPlanner.tsx` (or colocated in
   `BacklogDrawer.tsx` if under ~120 lines), following the `DeadBlockerButton` popover
   mechanics: absolute placement, outside-click close, `Escape` closes the popover only
   (stop propagation so the drawer survives), focus management back to the trigger.
   Content:
   - Head: priority mark, title, kind/agent/age line.
   - Intent excerpt (clamped; the full text lives in the editor).
   - **Why this one**: the plan entry's `reason` verbatim when present (quoted as the
     Foreman's words), then computed lines: priority band, age, "no blockers", and
     "unblocks N tasks" when N > 0. When the plan has no entry for the task (unplanned
     tail), say so plainly: ordered by priority and age.
   - **Launch now** - `api.dispatchBacklog(task.id, true)`, then close the popover (the
     drawer stays; the row leaves the ready band via SSE).
3. **The footer autopilot line.** In `BacklogDrawer.tsx`'s footer (slot from Phase 1),
   beside the Sitrep button: the readout sentence from `status.autopilot` and a switch
   bound to `autoBacklog` through `useForeman`'s config update path (the value App already
   holds; thread the needed props from App the same way ForemanBar gets them). Disabled
   state while the write is in flight; the readout re-renders from the next poll.
4. **Styles.** `src/web/styles.css`: the planner popover in the popover family recipe
   (panel background, border, radius 8-12px, shadow, z-index above the drawer body), sized
   ~460px per mockup B; the footer line's layout. Place beside the other Line drawer rules.
5. **Unit and render tests.** `test/line-drawer.test.ts` (or a sibling file if it grows
   unwieldy): projections for the trigger's accessible name and `aria-haspopup`; popover
   content with and without a plan `reason`; unplanned-tail copy; footer readout for on/off
   shapes. Pure derivation of "unblocks N" belongs with the other `shared/backlog.ts`
   consumers if a helper is extracted there.
6. **Playwright specs.** `e2e/specs/line-drawers.spec.ts`: seed tasks plus a plan with a
   `reason` via `PUT /api/backlog/plan`; open the drawer, click the next-up trigger, assert
   the reason text and the computed lines render; Launch from the popover dispatches the
   fake agent and the popover closes while the drawer stays; `Escape` closes popover first,
   drawer second; toggle autopilot and assert `GET /api/foreman/config` reflects
   `autoBacklog` (use `expect.poll`) and the footer readout updates.
7. **README.** In the Line drawer table, extend the Backlog row's description with the
   planner and the autopilot line; cross-reference the Foreman section's `autoBacklog`
   description so both name the same switch.

## Data, API, and migration notes

Nothing new. Reads: SSE tasks, the existing plan poll, the existing foreman config/status
poll. Writes: `POST /api/tasks/:id/dispatch` and `PUT /api/foreman/config`, both existing
Zod-validated routes through existing client wrappers. No schema, storage, or protocol
change. No migration.

## Tests and verification

- `npm run typecheck && npm run lint`
- `npm test` - line-drawer suites plus foreman-related render tests stay green.
- `npm run build && npm run test:e2e` - the extended `line-drawers.spec.ts`.
- Runtime visual pass against mockup B (`docs/archive/mockups/backlog-expanded-menu.html`): popover
  anchoring, spacing, and the footer line in both autopilot states.

## Merge and exit criteria

- All checks green; README matches behavior; no unrelated edits.
- The popover never renders without a ready task; the trigger is absent when nothing is
  ready (Phase 1's attention copy already explains why).
- Toggling autopilot from the drawer and from ForemanBar are observably the same state.
- A reviewable PR; nothing depends on this phase downstream.

## Downstream handoff

Terminal phase. Later work touching the planner popover or the autopilot line starts from
this file's contracts; the drawer row layout remains Phase 1's.

## Cross-phase audit record

- 2026-08-02: initial write, audited against Phase 1. Consumes exactly the handoff Phase 1
  names: the footer slot (extends, does not move the Sitrep button), the static next-up
  pill (replaced here with the trigger - the one row element Phase 1 ceded), and
  `BacklogDrawer`'s props. Verified no contract requires editing Phase 1: the plan poll and
  foreman state are App-held already, so no new prop shape had to be back-ported. Escape
  layering (popover before drawer) is owned here because the popover is the only nested
  dismissable either phase introduces.
- 2026-08-03: built and merged as PR #411. Seven deviations from the route above, each
  argued in that PR's description:
  1. The footer readout drops `ready/blocked/disabled`. The drawer's header already counts
     those three, forty pixels up, in the drawer's vocabulary ("parked", where the status
     object says "disabled"). The footer keeps what the header cannot say - armed state,
     capacity, and what the two together mean for the queue.
  2. A gate state this file did not name: `nothing launches until Foreman is live`, for an
     armed autopilot behind either half of `cfg.enabled && mode === "live"`.
  3. Phase 1's static footer sentence gave up its slot to the readout. The Sitrep button
     did not move - the contract was about the button, and the button is where it was.
  4. Mockup B's "Then" list was not built: those rows are the drawer the panel sits on.
  5. `position: fixed` with an inline `--bl-planner-fit`, NOT the `DeadBlockerButton`
     popover's absolute placement this file proposed - which is clipped by the capped,
     scrolling `.line-drawer-body` and by `.line-drawer`'s own `overflow: hidden`. The
     dismissal mechanics (outside click, Escape, focus return) are that component's.
  6. Escape layering is a React `onKeyDown` on the anchor rather than a `document`
     listener, because it must run BELOW the fleet's `window` handler to stop it.
  7. `dependentsIn` was extracted into `src/shared/backlog.ts` (built on `blockersIn`, so
     "unblocks N" is the exact inverse of what makes a row blocked), as this file allowed.

  Two repo guardrails were answered rather than bypassed: the popover joins
  `UNREGISTERED_DIALOGS` in `test/overlay-registry.test.ts` with its reasoning, and
  `.bl-planner-pop` joins the `.is-desktop` no-drag rule.
