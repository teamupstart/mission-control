# Phase 3 - Line strip and fold event

## 1. Outcome

The Fleet gains the Line: a permanent ~90px pipeline strip above every session layout - intake,
backlog, working, review, decide, shipped - each stage showing a glyph, a count, and one summary
sentence, amber when it needs the operator. Stage folds are computed server-side and delivered as
one change-gated SSE event (`line_summary`); the strip never recomputes fleet state in the browser.
Stage clicks navigate to existing views (no drawers yet - phase 4). The Shipped stage carries the
per-PR cost figure from `FleetCost.prsToday`.

Visual reference: `docs/archive/mockups/automation-prominence-2/1-library-line.html`, Frame A strip.

## 2. Entry criteria and dependencies

- Direct prerequisites: none (concurrent with phases 1 and 2).
- Entry state: `main` with `docs/plans/library-and-line/` present.

## 3. Scope and non-goals

In scope:

- `LineSummary` contract in `src/shared/` (browser-safe, no `node:` imports): six stages, each
  `{ stage, count, sentence, tone }` plus whatever stable ids drawers will key on.
- Server fold in the daemon (registry + workflow/ensemble/task/schedule stores), change-gated
  emission following the `cost_fleet` precedent; included in the SSE snapshot for new clients.
- `useEventStream.ts` handles the new event exhaustively; a `lineSummary` store reaches the fleet
  page.
- The strip component on the fleet page above `GridView | ConsoleView | BoardView`; wires/dots
  animation honoring `prefers-reduced-motion`; stage buttons with accessible names.
- Interim click targets: intake → the sources/schedules surface, backlog → the backlog surface,
  working → fleet as-is, review → the runs tab (`#/workflows/runs` until phase 4), decide → the
  ensembles tab, shipped → the runs tab filtered to completed (or the PR list surface if one
  exists; implementer's judgement, recorded in the README).
- README: the Line section.

Non-goals:

- No drawers, no `esc` handling, no route re-homing (phase 4).
- No new DB tables; folds are in-memory projections of state the daemon already holds.
- No session-card or board-layout changes: the strip sits above the layouts; cards render exactly
  as today.
- No cost computation changes (`prsToday` consumed as-is).

## 4. Repository findings and inherited contracts

- SSE precedent: `cost_fleet` - server-computed, change-gated (`src/server/registry.ts`
  `fleetEstimatedCostSince` ~3779, gate ~3818), one payload, exhaustive client switch
  (`src/web/useEventStream.ts`).
- Fold inputs already projected for SSE: `WorkflowRunSummary` (status/phase/actionWait/round),
  `EnsembleSummary` (strategy, decision-wait), task and schedule stores, session states in the
  registry. The fold must reuse these projections, not re-derive from DB.
- Fleet layouts render from `App.tsx` (~1803): `GridView | ConsoleView | BoardView`; the strip
  mounts once above whichever layout renders.
- Electron geometry tests measure real laid-out height on macOS; a permanent strip changes fleet
  geometry and the affected expectations live in the Electron test suite.
- Inherited contracts: none consumed. Phase 1's chip and phase 2's segment do not touch the fleet
  content area; this phase does not touch the topbar.

## 5. Implementation steps

1. `src/shared/` (new module, e.g. `line.ts`): `LineSummary`, stage ids
   (`intake | backlog | working | review | decide | shipped` - append-only once shipped), tones,
   and the `line_summary` `ServerEvent` variant added beside existing event types.
2. Server: a fold builder (new `src/server/line-summary.ts` or a registry-adjacent module) that
   composes: intake (task sources sweep recency + next schedule), backlog (task counts + next up),
   working (session states incl. needs-you count), review (live workflow runs; action-wait count
   called out), decide (ensembles waiting on decision), shipped (adopted PRs this week +
   `FleetCost.prsToday`-derived per-PR figure). Emit change-gated; include in snapshot. The daemon
   remains the only DB reader/writer; the fold reads in-memory stores.
3. `src/web/useEventStream.ts`: handle `line_summary` in the exhaustive switch; expose the store.
4. `src/web/components/LineStrip.tsx` (new): six stage buttons + wires per the mockup vocabulary
   (glyphs, mono uppercase stage names, count, one-line sub with ellipsis); amber attention tone;
   `prefers-reduced-motion` disables wire animation; each stage is a `button` with an accessible
   name like "Review - 5 runs live".
5. Mount in the fleet page above the layouts; no layout-internal changes.
6. Interim navigation per scope; keep the mapping in one place so phase 4 can swap targets to
   drawers.
7. README: the Line section with the stage table.
8. Tests:
   - `test/`: fold-builder unit tests (given store fixtures, stage counts/sentences/tones);
     snapshot-inclusion and change-gating tests alongside existing registry emission tests;
     `renderToStaticMarkup` for strip markup shape.
   - e2e `e2e/specs/line-strip.spec.ts`: with seeded fake-agent state, the strip renders six
     stages with counts; the review stage navigates to the runs view; attention tone appears when
     a decision is pending.
   - Electron geometry: update/extend fleet height expectations for the strip.

## 6. Data / API / migration

New `ServerEvent` variant `line_summary` (additive; append-only id discipline per change
contracts). No DB change, no HTTP route change. Old dashboards simply ignore unknown events per
the existing client tolerance; the new client requires the event only for the strip.

## 7. Verification

`npm run typecheck && npm run lint && npm test`; `npm run build && npm run smoke`;
`npm run test:e2e` including the new spec; `npm run test:electron` on macOS. Manual: strip counts
match the runs/ensembles tabs and backlog at a glance; reduced-motion renders static wires.

## 8. Merge and exit criteria

- Strip live on every fleet layout with server-fed folds only.
- Stage clicks navigate; no drawer code shipped.
- Geometry tests updated; all checks green; README matches.

## 9. Downstream handoff

Later phases may rely on: the `line_summary` event and `LineSummary` shape (append-only), the
stage id vocabulary, the strip component's stage-button structure, and the single click-target
mapping point. Later phases must not: recompute folds client-side, add stages without appending to
the shared contract, or move the strip off the fleet page.

## 10. Cross-phase audit record

- 2026-08-02: drafted against `81fd089`. Interim click targets deliberately point at the two-tab
  Workflows page that phase 2 leaves standing; phase 4 swaps them to drawers + re-homed routes.
  Confirmed no file overlap with phase 1 (topbar right) beyond `App.tsx` disjoint regions, and
  with phase 2 (topbar left + router) the strip touches neither the router union nor the segment.
