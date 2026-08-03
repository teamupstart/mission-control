# Shipped surface - phased implementation plan

Implementation index for [plan.md](plan.md), the approved Shipped-surface plan.
Rendered as [phased-plan.html](phased-plan.html); each phase links its detailed
implementation file.

## Source plan and incorporated decisions

Source: `docs/plans/shipped-surface/plan.md` (approved 2026-08-02).

- **Surface:** Drawer + ship log (A then B). Clicking Shipped opens a Shipped
  drawer in The Line; the drawer escalates to a new cross-repo Ship log page.
- **Data:** store PR titles on the adoption ledger. Per-PR cost approximation
  and the embedded merge matrix were not adopted.
- **Follow-up:** this phased plan.

## Investigated findings

Discrepancies between the source plan and the repository, resolved here as
explicit decisions:

1. **No title exists at adoption time.** The adoption signal (`PrOpened` in
   `src/server/registry.ts:164-174`, fed by the hook's `prCreated`/`prUrl` or the
   driver's `pr_created` event) carries only the URL and session context, and
   `announcePrOpened` is guarded against anything slow or fallible on the hook
   ingest path. The Inspector's per-tick GraphQL poll already fetches `title`
   (`PrSnapshot.title`, `src/server/inspector/github.ts:146,343`) and its
   observer write site (`src/server/inspector/worker.ts:522-540`) is where
   `observed_*` and `head_ref_name` are recorded today. **Decision:** the
   `title` column is written by that observer patch at zero extra network cost;
   it is null between adoption and the first poll (the documented `observed_*`
   precedent), and every renderer falls back to `head_ref_name`. This honors
   the approved decision's intent - the title is durable on the ledger row, no
   lazy client fetch - and corrects its mechanism.
2. **The drawer frame has no footer.** `LineDrawer.tsx` composes a header
   (title, count, `actions`, close) over a capped scrolling body; all three
   existing drawers put their escalation ("All runs →", etc.) in the header
   `actions` slot. **Decision:** the Shipped drawer's "Ship log →" ships in the
   `actions` slot, matching the precedent instead of changing the frame for all
   four drawers.
3. **The existing PR read is wrong for this surface.** `GET /api/inspector/prs`
   returns `loadInspectorInspections(50)`: 50 rows ordered by review recency
   (`COALESCE(last_reviewed_at, adopted_at) DESC`), which can truncate and
   reorder a busy week. **Decision:** Phase 1 adds an adoption-window read
   (`adopted_at >= since`, ordered `adopted_at DESC`, uncapped) exposed as an
   `adoptedSince` query parameter on the same route - reusing the ledger route,
   the codebase's own recorded argument against minting a second route over the
   same rows (`src/web/useShipping.ts:6-12`, `src/server/routes.ts:2842-2846`).
4. **The click target flips once, not twice.** Flipping the Shipped stage's
   target invalidates the pinned assertion in `test/line-drawer.test.ts:104-111`,
   the observation in `e2e/specs/line-strip.spec.ts:138-144`, and the committed
   evidence transcript quoted in `e2e/README.md`. **Decision:** Phase 2 ships
   the Ship log page reachable by route and palette without touching the stage
   click; Phase 3 performs the single flip to the drawer.
5. **e2e seeding for adoption exists, indirectly.** No route writes the ledger
   directly, but the production adoption signal is HTTP: `POST /hooks/:event`
   with `prCreated: true` and `prUrl` adopts through the real code path. Specs
   dispatch a fake-agent session, post the hook ingest, and the ledger row
   appears with `title` null (rendering the branch fallback). Title-specific
   rendering is asserted with `page.route` fulfillment, the idiom
   `e2e/specs/line-drawers.spec.ts:286-287` already uses.

## Phases

| # | Phase | File | Direct prerequisites |
|---|---|---|---|
| 1 | Ledger titles and the adoption-window read | [phase-1-ledger-titles-and-window-read.md](phase-1-ledger-titles-and-window-read.md) | none |
| 2 | Ship log page | [phase-2-ship-log-page.md](phase-2-ship-log-page.md) | Phase 1 |
| 3 | Shipped drawer and the click flip | [phase-3-shipped-drawer.md](phase-3-shipped-drawer.md) | Phase 2 |

## Dependency graph and concurrency

```
Phase 1 (server + shared foundation)
   |
Phase 2 (Ship log page; stage click unchanged)
   |
Phase 3 (Shipped drawer; the one click flip; escalates to Phase 2's page)
```

The graph is a chain; there are no concurrent phases. Phase 3 lists only
Phase 2 as its direct prerequisite - its dependency on Phase 1's `title` field
and windowed read is transitive through Phase 2. Merge order: 1, then 2, then 3.
Every phase leaves the repository valid and testable: after 1, the ledger
carries titles nothing yet renders; after 2, the Ship log exists at `#/shipped`
while the Shipped click still routes to completed runs; after 3, the approved
behavior is complete.

## Cross-phase contracts

Fixed by Phase 1, consumed by 2 and 3:

- `InspectorPr.title: string | null` (wire field `title`); null means "not yet
  polled since the column existed"; renderers fall back to `headRefName`.
- `GET /api/inspector/prs?adoptedSince=<epoch ms>` returns
  `InspectorInspection[]` filtered `adopted_at >= since`, ordered
  `adopted_at DESC`, uncapped. Without the parameter the route's existing
  behavior is byte-for-byte unchanged.

Fixed by Phase 2, consumed by 3:

- `MissionRoute` member `{ page: "shipped" }`, hash `#/shipped`.
- The page's h2 heading "Ship log" (what e2e and the palette name).
- The PR-standing helpers' shared location (`mergeStatus` / `mergeBucket` and
  the coarse merged / open / gone mapping), lifted out of
  `ShippingSettingsPanel.tsx` so a non-settings surface can import them.

Phase 3 consumes both sets and changes neither.

## Final verification strategy

Per phase: `npm run typecheck`, `npm run lint`, `npm test`, plus
`npm run build && npm run smoke` where build or runtime surfaces change, and
`npm run test:e2e` with new or updated specs for every UI-visible change
(phases 2 and 3). Phase 3 additionally regenerates the Line evidence
transcripts (`MC_E2E_EVIDENCE=1`) because a committed transcript quotes the
old click target. After Phase 3 merges, the end state is checked against the
source plan: Shipped click opens the drawer, drawer escalates to `#/shipped`,
titles render with branch fallback, and no surface still routes Shipped to
workflow runs.

## Audit record

- 2026-08-02: initial decomposition after repository investigation; findings
  1-5 above recorded as decisions. Phase files written in dependency order
  with cross-phase audits after each.
