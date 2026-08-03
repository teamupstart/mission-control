# Phase 1 - Ledger titles and the adoption-window read

Part of [phased-plan.md](phased-plan.md) for [plan.md](plan.md). Server and
shared foundation; no UI surface changes in this phase.

## 1. Outcome

The adoption ledger (`inspector_prs`) carries each PR's title, kept current by
the Inspector's existing per-tick poll, and the ledger route can serve "every
PR adopted since T" ordered by adoption time. This is the data both UI phases
render; it ships first so the drawer and the page consume a fixed contract.

## 2. Entry criteria and dependencies

- Direct phase prerequisites: none (first phase).
- The planning PR that publishes these documents has merged (the scheduled
  task's dependency enforces this).

## 3. Scope and non-goals

In scope: schema migration, shared type, row mapper, the two ledger writers,
the observer capture, the windowed read, the route parameter, focused tests.

Non-goals: any UI change, `PrLink`, `src/web/lib/api.ts`, the drawer, the page,
README product prose (nothing user-visible changes), any code in
`src/server/workflows/manager.ts` (see the test guard below).

## 4. Repository findings and inherited contracts

- `inspector_prs` CREATE TABLE: `src/server/db.ts:929-968`. Migrations are
  idempotent `addColumn` calls inside `migrate()` (`db.ts:1414`); the
  `inspector_prs` cluster ends at `db.ts:1765` with the four observer columns,
  whose comment documents the "null until first poll" semantics this phase
  reuses. Project rule: anything referencing an ALTER-added column (including
  any index) lives in `migrate()`, never beside the CREATE.
- `adoptInspectorPr` (`db.ts:5117-5166`): 27-column INSERT with
  `ON CONFLICT(key) DO NOTHING` - a re-adoption can never fill a title later,
  which is why capture belongs to the poll.
- The only production adoption caller: `adoptPr` in
  `src/server/inspector/worker.ts:376-419`; its context has no title.
- Observer write site: `src/server/inspector/worker.ts:522-540` patches
  `observedHeadSha` / `observedState` / `observedAt` / `headRefName` from a
  `PrSnapshot`; `PrSnapshot.title: string` already exists
  (`src/server/inspector/github.ts:146`, normalized at `:343`) and is already
  consumed elsewhere (`worker.ts:799`). Capturing it here costs zero network.
- `updateInspectorPr` (`db.ts:5168-5235`): explicit patch type + full-column
  UPDATE; new fields must be added to the patch type, SET list, and args.
- Row plumbing is explicit: `InspectorPrRow` (`db.ts:5055-5083`) and
  `rowToInspectorPr` (`db.ts:5085-5115`) - a column absent from the mapper is
  silently dropped even though queries use `SELECT p.*`.
- `loadInspectorInspections` (`db.ts:5373-5411`): grouped query joining
  `inspector_comments`, ordered by review recency, `limit ?? -1`. Six callers;
  the route caps at 50 (`src/server/routes.ts:2810`).
- `prsOpenedSince` (`db.ts:4219-4233`) is the provenance rule (`adopted_at`)
  the Line's count uses; the windowed read must use the same column so the
  drawer rows and the strip count cannot disagree.
- `loadAdoptedInspectorPrsSince` (`db.ts:5252-5282`) is NOT a time window
  despite the name (it filters on `observed_at` for the `pull_request` session
  action); do not reuse or repurpose it.
- No Zod schema covers `InspectorPr` on the wire; it is a plain interface in
  `src/shared/types.ts:1802-1904` serialized by `c.json`.
- Test guard: `test/inspector-adoption.test.ts:201-210` asserts
  `manager.ts` never matches `/\badoptPr\b|\badoptInspectorPr\b/`.
- Naming: avoid a bare `shipped` identifier in server code -
  `src/server/shipping/` means the YOLO auto-merge worker, and
  `src/server/workflows/store.ts` uses `shipped` to mean "bundled builtin".
  Prefer `adopted*` names for the accessor.

## 5. Implementation steps

In execution order:

1. `src/shared/types.ts`: add `title: string | null` to `InspectorPr` with a
   doc comment stating the null semantics (null = not polled since the column
   existed; renderers fall back to `headRefName`) and that the poll, not
   adoption, writes it.
2. `src/server/db.ts`: add `title` to `InspectorPrRow` and `rowToInspectorPr`.
3. `src/server/db.ts` `migrate()`: `addColumn(d, "inspector_prs", "title",
   "TEXT")` appended to the `inspector_prs` cluster (after line 1765), with a
   comment following the observer-columns precedent. No index: the table gains
   single-digit rows a day; if one is ever added it lives here, not in the
   CREATE block.
4. `src/server/db.ts` `adoptInspectorPr`: add the column, the placeholder, and
   the arg (`pr.title`); `adoptPr` in `worker.ts` passes `title: null`
   ("adoption is not an observation", same as the observer fields).
5. `src/server/db.ts` `updateInspectorPr`: add `title?: string | null` to the
   patch type, SET list, and run args.
6. `src/server/inspector/worker.ts:522-540`: add `title: s.title || null` to
   the observer patch, so every tick records (and re-records, handling
   retitles) the title beside the observation it came from.
7. `src/server/db.ts`: add the windowed read - a sibling of
   `loadInspectorInspections` (proposed name `loadAdoptedInspectionsSince(
   sinceMs: number): InspectorInspection[]`): the same grouped
   finding-tally query with `WHERE p.adopted_at >= ?` before the GROUP BY and
   `ORDER BY p.adopted_at DESC`, no LIMIT. Document it against
   `prsOpenedSince`'s provenance argument. (A sibling, not a new parameter on
   `loadInspectorInspections`, keeps the six existing call sites untouched;
   collapse them only if the diff stays honest.)
8. `src/server/routes.ts` (inspector cluster, after line 2810): extend
   `GET /api/inspector/prs` with an optional `adoptedSince` query parameter
   (epoch ms, read via `c.req.query`, validated as a finite number; invalid ->
   400). With the parameter: the windowed read. Without: the existing
   `loadInspectorInspections(50)` byte-for-byte. Import the accessor in the
   existing `from "./db.ts"` block.

## 6. Data, API, and compatibility

- Migration is idempotent and opens old databases safely: `addColumn` no-ops
  when present; legacy rows read `title = NULL`, the documented "not looked
  since the column existed" state, filled within one poll interval for open
  PRs. Closed or merged rows adopted before this build may keep `title` null
  forever (the tick retires non-open rows); the branch fallback is the honest
  render, and this is recorded as accepted behavior, not backfilled with a
  network sweep.
- Wire: additive optional-shaped field on `InspectorInspection` responses; the
  two existing consumers (`useInspector`, `useShipping`) ignore unknown fields.
- The unparameterized route response is unchanged, so the settings panels see
  no difference.

## 7. Tests and verification

New cases in `test/` (node:test + node:assert/strict, alongside the existing
inspector tests):

- Migration: opening a database created without the column adds it; reopening
  is a no-op (the `test/inspector-observation-migration.test.ts` shape).
- Adoption leaves `title` null; `updateInspectorPr` with a `title` patch
  persists it; the observer patch shape captures `s.title || null` (empty
  string becomes null).
- Windowed read: rows outside the window excluded, ordering `adopted_at DESC`,
  finding tallies still correct, no cap.
- Route: `adoptedSince` present/absent/invalid via the in-process HTTP test
  layer (`test/http-integration.test.ts` conventions).

Commands: `npm run typecheck`, `npm run lint`, `npm test` (or the focused
files via `node --test --test-concurrency=2 --import tsx test/<file>`), then
`npm run build && npm run smoke` (runtime surface changed).

## 8. Merge and exit criteria

- All of section 7 green in CI.
- No e2e spec: this phase has no UI surface (route edge cases belong in
  `test/`, per AGENTS.md).
- The worktree contains only this phase's changes.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- `InspectorPr.title: string | null` (field name and null semantics).
- `GET /api/inspector/prs?adoptedSince=<epoch ms>` returning
  `InspectorInspection[]`, `adopted_at >= since`, ordered `adopted_at DESC`,
  uncapped; parameterless behavior unchanged.
- The renderer obligation: fall back to `headRefName` when `title` is null.

## 10. Cross-phase audit record

- 2026-08-02: written first; contracts above are the ones Phase 2 and Phase 3
  consume. Confirmed no adoption code touches `manager.ts` and the accessor
  naming avoids the `shipping`/`shipped` collisions.
