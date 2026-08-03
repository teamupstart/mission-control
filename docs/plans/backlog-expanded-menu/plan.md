# Backlog expanded menu: the queue drawer and the autopilot planner

Clicking the BACKLOG stage on The Line opens the Sitrep panel today (README's Roundup). That
panel reads the whole fleet; the stage click deserves a surface about the backlog itself. This
plan delivers two composed features, explored as mockups A and B in
`docs/mockups/backlog-expanded-menu.html`:

- **The queue drawer (A)**: Backlog joins Intake, Review, and Decide as the fourth Line drawer.
  Plan-ordered rows, one per task, with the actions an operator reaches for while triaging:
  launch now, park/resume, priority.
- **The autopilot planner (B)**: an anchored popover opened from the drawer's next-up
  affordance, saying what autopilot would take next and why - the Foreman's own recorded
  reason plus the computed facts - with a launch button. The autopilot readout and toggle
  live in the drawer's footer.

## What the repository already provides

Verified against the code, not the mockups:

- **The drawer seam is ready.** `src/web/lib/line-drawer.ts` (`LINE_DRAWER_STAGES`) and
  `src/web/lib/line-targets.ts` (`backlog: { kind: "sitrep" }`) were cut exactly for this:
  adding a fourth drawer is that list, the target table, a glyph in
  `src/web/components/line/LineDrawer.tsx`, a body component, and a render site in `App.tsx`
  beside the other three. The `LineDrawer` frame owns focus, `esc`, `aria-controls`, and the
  three-row/38vh body cap.
- **Every queue action already has a route.** Launch: `POST /api/tasks/:id/dispatch`
  (`api.dispatchBacklog`). Park/resume: `POST /api/tasks/:id/update` with `enabled`
  (`ScheduleSwitch` in `session-bits.tsx` is the shared control). Priority: same route with
  `priority`. Dead prerequisites: `DeadBlockerButton` (reschedule / mark done) is a shared leaf.
  No new endpoint is needed for the drawer.
- **Order is computed, and the browser holds everything needed.** `readyBacklog(tasks, plan)`
  in `src/shared/backlog.ts` is plan-entry order first, then priority/age; `nextUpTaskId` is
  its head - the same derivation the daemon's fold uses for the stage sentence, so the drawer
  introduces no second source of truth. `App.tsx` already holds `tasks`, `visibleBacklog`, and
  `foreman.backlogPlan` (polled every 4s by `useForeman`).
- **The planner's "why" exists server-side.** `BacklogPlanEntry` carries
  `reason: string | null` - the Foreman's own explanation for each planned task. The featured
  section quotes it and adds the computed facts (priority band, age, blocker status, how many
  tasks it unblocks via `backlogIndex`).
- **Autopilot state is real and toggleable.** `ForemanConfig.autoBacklog`
  (`PUT /api/foreman/config`) with the derived readout
  `status.autopilot { on, active, max, ready, blocked, disabled }`. The only UI for it today is
  the ForemanBar checkbox.

## Where the mockups and the repository disagree

Recorded as decisions, not silently copied:

1. **"Move to top" (mockup A) has no backing.** No rank field, no reorder route; the operator's
   ordering levers are priority and dependencies. Resolution below.
2. **"Skip once" (mockup B) has no backing.** The worker's cooldowns are in-memory and not
   operator concepts; the operator-facing skip today is `enabled: false` (park). Resolution
   below.
3. **Naming: Sitrep vs Roundup.** The panel is `ReportPanel`, README calls it Roundup, the
   Line comment and button call it Sitrep. The drawer's escalation link follows whatever the
   panel's accessible name is today (Sitrep); this plan does not rename anything.

## Design

### The queue drawer

Clicking BACKLOG toggles the Backlog drawer in place of opening the Sitrep, with the same
radio-group toggle/swap behavior the other three stages have (`nextLineDrawer`). The body:

- **Ready band**, in `readyBacklog` order. Each row: priority mark and title, kind/agent/age
  meta, and actions - Launch now (`dispatchBacklog`), park (`ScheduleSwitch` semantics), and
  an inline priority select (the ordering lever that actually exists, reusing the
  `BacklogColumn` pattern). The head of the list carries the next-up marker.
- **Blocked and parked band**: blocked rows show their blocker (from `blockersIn`), with the
  shared `DeadBlockerButton` when the blocker is dead; parked rows dim and offer Resume.
- **Header count**: `N ready · N blocked · N parked`, amber attention half when nothing is
  ready but tasks exist (mirroring the fold's `tone: "attention"` case).
- **Footer escalation**: one link to the Sitrep panel, which keeps the full-fleet read.
- **Empty state**: a `LineDrawerEmpty` sentence pointing at Intake and the dispatch modal.

### The autopilot planner

The planner is a second surface: an anchored popover in the app's existing popover family
(`.launch-pop` recipe), opened from the next-up affordance inside the drawer - the "next up"
marker on the head row is the trigger, so the queue read stays one click and the "why" is one
more. It contains:

- The next-up task: priority, title, intent excerpt.
- **Why this one**: the plan entry's `reason` verbatim when present, plus computed lines -
  priority band, age, "no blockers", "unblocks N tasks".
- **Launch now** (same dispatch route).
- When nothing is ready, the next-up affordance is absent and the drawer's attention copy
  states why (all blocked / all parked / empty) instead.

The autopilot readout and toggle live in the drawer itself, not the popover: a footer line
under the rows with the `status.autopilot` readout
(`on · active/max · ready/blocked/disabled`) and a toggle bound to
`ForemanConfig.autoBacklog` - the same config write the ForemanBar checkbox makes, never a
parallel state. The footer also carries the Sitrep escalation link, so the frame gains one
optional footer slot.

## Adopted decisions

Submitted through the dashboard review of this plan:

1. **Composition: two surfaces.** The BACKLOG click opens the queue drawer; the planner keeps
   mockup B's anchored-popover form, opened from the drawer's next-up affordance. Not merged
   into one panel.
2. **Ordering control: inline priority select per row.** The lever that exists
   (`updateTask` with `priority`), reusing the `BacklogColumn` pattern. No rank/pin concept.
3. **Skip once: dropped.** Park covers deferral; no new deferral state.
4. **Autopilot: readout plus toggle in the drawer**, bound to the existing
   `ForemanConfig.autoBacklog` write.

## Contracts and constraints

- `LINE_STAGE_TARGETS` flips `backlog` to `{ kind: "drawer", stage: "backlog" }`;
  `LINE_DRAWER_STAGES` gains `"backlog"`; `lineStageHasDrawer` then advertises
  `aria-expanded` on the stage button for free. `test/line-drawer.test.ts` pins the current
  three-stage list and changes deliberately with this plan.
- All mutations go through existing Zod-validated routes; no hand-parsing, no new endpoint.
  The autopilot toggle writes through the existing `PUT /api/foreman/config` client wrapper.
- The drawer reads only state the browser already holds (SSE tasks, `useForeman` plan poll);
  no new fetch on open, unlike Intake's one-shot sources read.
- UI changes require Playwright specs in `e2e/specs/line-drawers.spec.ts` (role/label
  selectors, never `data-testid`; seed via `POST /api/tasks` with `backlog: true`, park via
  `/update`, blockers via `dependencies`). Markup projections extend
  `test/line-drawer.test.ts`; the Electron geometry tests cover the cap if row height changes.
- README updates land in the same changes: the stage click table row (line ~4292), the drawer
  table (~4331), and the three-of-six drawer arithmetic (~4286), plus the Backlog stage row if
  the sentence changes.
- Keyboard: no new shortcut; `esc` and focus behavior come from the frame. The `r` Roundup
  shortcut is untouched.

## Out of scope

- Renaming Sitrep/Roundup, or changing the Sitrep panel itself.
- Manual backlog reordering (rank/pin) beyond priority, unless decided otherwise above.
- Quick-add capture, aging radar, and dispatch-cockpit ideas from mockups C, D, E.
- Any change to the Foreman planner's algorithm or the plan storage.

## Verification

- `npm run typecheck`, `npm run lint`, `npm test` (line-drawer, line-strip, backlog suites).
- `npm run build` then `npm run test:e2e` with new specs: stage click opens the drawer (not
  the Sitrep), toggle/swap/esc semantics, ready/blocked/parked rows render seeded tasks,
  launch dispatches the fake agent, park flips `enabled`, planner shows the seeded plan
  reason, autopilot toggle round-trips `autoBacklog`.
- Visual pass against the mockups for spacing, tones, and the cap behavior.
