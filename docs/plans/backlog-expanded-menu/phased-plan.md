# Phased plan: backlog expanded menu

Implementation index for [plan.md](plan.md) - the approved source plan turning the BACKLOG
stage click into the queue drawer (mockup A) and the autopilot planner (mockup B), per the
mockups in `docs/archive/mockups/backlog-expanded-menu.html`.

## Incorporated human decisions

Submitted through the dashboard review of the source plan and written into it:

1. **Composition: two surfaces.** The click opens the queue drawer; the planner is an
   anchored popover opened from the drawer's next-up affordance.
2. **Ordering control: inline priority select per row.** No rank/pin concept.
3. **Skip once: dropped.** Park covers deferral.
4. **Autopilot: readout plus toggle in the drawer**, bound to `ForemanConfig.autoBacklog`.
5. **Follow-up: create this phased implementation plan** and schedule its tasks.

## Investigated findings that shaped the split

- The drawer seam (`LINE_DRAWER_STAGES`, `LINE_STAGE_TARGETS`, the `LineDrawer` frame) was
  built for a fourth stage; no strip or App architecture changes are needed.
- Every action in scope has an existing Zod-validated route and client wrapper; neither
  phase adds an endpoint, schema, or migration.
- `BacklogPlanEntry.reason` (the Foreman's own explanation) and
  `status.autopilot` / `ForemanConfig.autoBacklog` already exist, so the planner is pure
  presentation over held state.
- "Move to top" and "Skip once" from the mockups have no backing; both were resolved by the
  adopted decisions rather than invented.
- `test/line-drawer.test.ts` pins the exact three-drawer list; changing it is a deliberate
  part of Phase 1, not a regression.

## Phases

| # | Phase | File | Direct prerequisites |
|---|-------|------|----------------------|
| 1 | The Backlog queue drawer | [phase-1-backlog-queue-drawer.md](phase-1-backlog-queue-drawer.md) | none |
| 2 | The autopilot planner | [phase-2-autopilot-planner.md](phase-2-autopilot-planner.md) | Phase 1 |

## Dependency graph and merge order

```
phase-1-backlog-queue-drawer  ──►  phase-2-autopilot-planner
```

Strictly serial: Phase 2 renders inside the component Phase 1 creates and extends its
footer. There are no concurrency groups. Merge order equals phase order.

## Cross-phase contracts

Named in the phase files' handoff sections; summarized:

- After Phase 1: `LINE_DRAWER_STAGES` includes `"backlog"`;
  `src/web/components/line/BacklogDrawer.tsx` exists with the props Phase 1 names; the
  `LineDrawer` frame accepts an optional `footer` slot containing the Sitrep button.
- The next-up marker is a static pill in Phase 1 and is the **one** row element Phase 2
  replaces (with the planner trigger). Everything else in the row layout is Phase 1's and
  stays.
- Phase 2 adds the autopilot line to the footer without moving the Sitrep button, and owns
  Escape layering (popover closes before drawer).

## Final verification strategy

Each phase runs its own gate (`typecheck`, `lint`, `npm test`, `build` + `test:e2e`, README
parity). After Phase 2 merges, the end state is checked against the source plan's
Verification section in one pass: stage click behavior, drawer semantics, bands and
actions, planner content including a seeded plan `reason`, and the autopilot toggle
round-trip observed from both the drawer and ForemanBar.

## Task map

One Mission Control task per phase, created after these artifacts are pushed; each task
depends on this planning session (released when the plan PR merges) and Phase 2's task
additionally depends on Phase 1's. Task ids are recorded in the plan PR description.
