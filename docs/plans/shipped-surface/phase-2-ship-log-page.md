# Phase 2 - Ship log page

Part of [phased-plan.md](phased-plan.md) for [plan.md](plan.md). The routed
cross-repo ledger (Mockup B in [plan.html](plan.html)). The Shipped stage's
click is NOT changed in this phase (finding 4 in the index); the page is
reachable at `#/shipped` and through the palette.

## 1. Outcome

A Ship log page at `#/shipped`: a KPI row (shipped this week with delta and
sparkline, merged count and rate, the existing fleet-wide per-PR cost figure,
active repos), a repository rail with per-repo merged / open / gone mix bars
doubling as a filter, and the ledger grouped by day - every row repo-tagged
with title (branch fallback), merge state, and owning session. This is where
"PRs merged across various repositories" becomes visible.

## 2. Entry criteria and dependencies

- Direct phase prerequisite: Phase 1 (its `title` field and
  `adoptedSince` windowed read are this page's data).

## 3. Scope and non-goals

In scope: the route member and parsing, the page shell slot, the page
component and its pure fold helpers, the shared PR-standing helpers, the
client fetch, palette reachability, tests, an e2e spec, README documentation.

Non-goals: the Shipped stage click target (`line-targets.ts` untouched), the
drawer, `LINE_DRAWER_STAGES`, any server change (Phase 1 provided the read),
per-PR cost, the merge matrix.

## 4. Repository findings and inherited contracts

From Phase 1 (fixed): `InspectorPr.title: string | null` with branch fallback;
`GET /api/inspector/prs?adoptedSince=<epoch ms>` -> `InspectorInspection[]`,
`adopted_at DESC`, uncapped.

Repository facts this phase builds on:

- `MissionRoute` union: `src/web/workflows/useWorkflowRoute.ts:63-86`. Parsing
  gotcha at `:178`: the legacy `/workflows/` prefix strip runs first - match
  `/shipped` on `path` (as `/settings` at `:221` does), not on `execution`.
  `missionRouteHash` (`:236-260`) ends in an UNGUARDED ensembles return: the
  new page needs an explicit branch before that tail, or every
  `navigate({page:"shipped"})` silently lands on `#/ensembles` with no type
  error. Round-trip test shape: `test/workflow-route.test.ts:15-21`.
- `AppPageShell.tsx` (42 lines): the `page` prop is its own hand-widened
  string union with `fleet` as the ternary fallback - a `"shipped"` member
  added to `MissionRoute` but not here silently renders the fleet. The page
  array test at `test/workflow-route.test.ts:202-231` enumerates the slots.
- Page composition precedent: `src/web/App.tsx:2148-2226` - each page is an
  `ExecutionPage` (`src/web/workflows/ExecutionPage.tsx`, props
  `{title, blurb, actions?, children}`) inside its `AppPageShell` slot, so an
  unrouted page's hooks never mount or poll. The eyebrow is the hardcoded
  string "Execution"; a Ship log is not execution, so parameterize the eyebrow
  with a default of "Execution" (or reuse it deliberately - implementer's
  call, recorded in the PR).
- `src/web/lib/palette-index.ts:559-572` `routeDestination` is an exhaustive
  switch with no default: the new page member is a compile error until it
  names a destination string.
- Data hooks: do NOT mount `useShipping`/`useInspector` here - both are 4s
  settings pollers carrying config writers. The precedent for a fleet-adjacent
  read is `IntakeDrawer`'s once-on-mount fetch with three states
  (loading / failed / data), because `fetchJson` resolves `null` on every
  failure and null must not collapse into "empty"
  (`src/web/components/line/IntakeDrawer.tsx:89-105`). The page fetches on
  mount and on range change; it mounts only when routed.
- `src/web/lib/api.ts:149` `fetchInspectorPrs` is the one-line fetch to extend
  with the optional window parameter.
- PR-standing helpers already exist as exports of
  `src/web/components/ShippingSettingsPanel.tsx`: `mergeStatus` (`:56-61` -
  the last line shows gh's verbatim refusal and is load-bearing),
  `MergeBucket`, `mergeBucket` (`:72-77`), `mergeTallies` (`:81-91`). Lift
  them into a browser-safe module (proposed `src/web/lib/pr-standing.ts`) and
  update the settings panel to import from it, so this page does not import a
  settings panel. Add there the coarse mapping this surface needs:
  merged (`mergedAt !== null` or `observedState === "MERGED"`), gone
  (closed without merge), open (everything else) - a fold over `mergeBucket`,
  not a fourth vocabulary.
- `PrLink` (`src/web/components/settings-console.tsx:279-297`) renders
  `repo#number` and its doc comment says it carries no title because
  `InspectorPr` had none - now stale. Give it an optional `title` and fix the
  comment. `SessionRef` (`:312-318`) is the precedent for the owning session:
  a handle, never a link (session ids re-mint).
- CSS: the routed pages own the `workflow-page` / `wf-` families
  (`src/web/styles.css:9532+`); the `sc-` family belongs to the settings
  console and the `line-*` families to the strip and drawers. New page styles
  join the `workflow-page` neighborhood with their own prefix (proposed
  `shiplog-`).
- The KPI row's per-PR figure is the existing fleet-wide number App already
  holds from the `cost_fleet` SSE state (the same derivation as
  `SpendChip.tsx:406-417`); pass it as a prop. Weekly delta and sparkline are
  client-side folds over a wider `adoptedSince` fetch (rows are never
  deleted); if the implementer finds the 12-week fetch disproportionate, the
  sparkline may be dropped in favor of count + delta - the mockup is the
  target, not a contract.

## 5. Implementation steps

1. `useWorkflowRoute.ts`: add `{ page: "shipped" }` to `MissionRoute`; parse
   `/shipped` on `path`; add the explicit `missionRouteHash` branch returning
   `#/shipped` BEFORE the ensembles tail.
2. `AppPageShell.tsx`: widen the `page` union, add the `shipped` slot prop and
   ternary arm.
3. `palette-index.ts`: name the destination in `routeDestination`.
4. `src/web/lib/pr-standing.ts`: move `mergeStatus` / `MergeBucket` /
   `mergeBucket` / `mergeTallies` from `ShippingSettingsPanel.tsx` (which now
   imports them); add the coarse merged / open / gone fold. Keep
   `test/settings-console.test.ts` green - move, don't fork.
5. `src/web/lib/api.ts`: `fetchInspectorPrs(adoptedSince?: number)` appending
   the query parameter.
6. `PrLink`: optional `title` prop (rendered as the row's primary text where
   present), doc comment corrected.
7. New page component (proposed `src/web/components/ShipLogPage.tsx`, pure
   folds beside it or in `pr-standing.ts`): range state (Today / 7 days /
   30 days, default 7), once-per-range fetch with the three-state pattern,
   KPI row, repo rail (counts + mix bars, click filters the feed,
   `aria-pressed`), day-grouped feed (local-midnight grouping; rows: state
   icon + label, repo tag, title with branch fallback, `PrLink`, `SessionRef`,
   relative time). Follow the mockup in `plan.html`; deviations are judgment
   calls recorded in the PR.
8. `App.tsx`: the `shipped` slot - an `ExecutionPage` (title "Ship log",
   blurb per the mockup's subline) wrapping the page, cost figure passed from
   App's existing fleet-cost state.
9. `styles.css`: `shiplog-` styles in the routed-page neighborhood; dark-only
   app tokens as everywhere else.
10. README: document the page where the execution pages are described, and add
    it to the palette section's reachable surfaces.

## 6. Data, API, and compatibility

No server changes. The page is a pure consumer of Phase 1's read plus App's
existing cost state. An unrouted page never mounts, so no new idle polling.

## 7. Tests and verification

- `test/workflow-route.test.ts`: `#/shipped` parse/serialize round trip; the
  `AppPageShell` page array gains the slot.
- `test/` unit coverage for the pure folds: day grouping, repo tallies, the
  coarse merged / open / gone mapping (including gh-refusal passthrough), and
  title-vs-branch fallback (renderToStaticMarkup where markup shape matters).
- New e2e spec `e2e/specs/ship-log.spec.ts`:
  - Seed by dispatching a fake-agent session and posting the adoption signal
    to `POST /hooks/:event` with `prCreated: true` and a `prUrl` (the
    production code path; finding 5 in the index). Assert the page at
    `#/shipped` shows the row with the branch fallback.
  - Title rendering and multi-repo rail/filter behavior via `page.route`
    fulfillment of `**/api/inspector/prs*` (the `line-drawers.spec.ts:286`
    idiom), including the failed-read state (500 -> failed, not empty).
  - Selectors by role/label only; no `data-testid`; the isolation rules in
    `e2e/README.md` (the fixtures already set `MISSION_POOL_REAP_MS=0` etc.).
- Commands: `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build && npm run smoke`, `npm run test:e2e`.

## 8. Merge and exit criteria

- Section 7 green in CI; the e2e spec covers the new surface.
- `#/shipped` reachable by hash and palette; the Shipped stage click is
  UNCHANGED (assert `line-targets.ts` has no diff in this PR).
- README matches the implementation.

## 9. Downstream handoff

Phase 3 may rely on, and must not change:

- `{ page: "shipped" }` / `#/shipped` and `navigate({ page: "shipped" })`.
- The page h2 heading "Ship log".
- `src/web/lib/pr-standing.ts` as the home of the standing helpers and the
  coarse merged / open / gone mapping.
- `fetchInspectorPrs(adoptedSince?)` in `src/web/lib/api.ts`.

## 10. Cross-phase audit record

- 2026-08-02: written second. Consumes Phase 1's contracts exactly as its
  handoff states them (field `title`, parameter `adoptedSince`, fallback
  rule). Confirmed against Phase 1 that no server change is needed here and
  that the standing-helper lift belongs to this phase (first non-settings
  consumer), so Phase 3 inherits it rather than moving files again.
