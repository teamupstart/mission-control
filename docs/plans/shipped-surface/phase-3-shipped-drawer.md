# Phase 3 - Shipped drawer and the click flip

Part of [phased-plan.md](phased-plan.md) for [plan.md](plan.md). The Shipped
drawer (Mockup A in [plan.html](plan.html)) and the single change of the
Shipped stage's click target. This phase completes the approved behavior.

## 1. Outcome

Clicking Shipped opens a drawer under the strip, like Intake, Review, and
Decide: the week's adopted PRs newest-first with merge state, title (branch
fallback), owning session, and time; chips filter All / Merged / Open / Gone;
the header escalates with "Ship log →" to Phase 2's page. The stage stops
routing to workflow runs.

## 2. Entry criteria and dependencies

- Direct phase prerequisite: Phase 2 (the escalation target `#/shipped`, the
  `pr-standing` helpers, and `fetchInspectorPrs(adoptedSince?)`). Phase 1's
  contracts arrive transitively.

## 3. Scope and non-goals

In scope: the drawer stage registration, glyph, body component, the
`line-targets.ts` flip, App wiring, drawer CSS, unit and e2e coverage
including the evidence-transcript regeneration, README corrections.

Non-goals: any server change; any change to Phase 1/2 contracts; the
`LineDrawer` frame's structure (no footer is added - see finding 2); the
drawer cap (`--line-drawer-row-h`, the 3-row / 38vh body cap) is untouchable.

## 4. Repository findings and inherited contracts

Inherited: `#/shipped` + heading "Ship log" (Phase 2);
`src/web/lib/pr-standing.ts` coarse merged / open / gone mapping (Phase 2);
`fetchInspectorPrs(adoptedSince?)` (Phase 2); `title` fallback rule (Phase 1).

Repository facts:

- `src/web/lib/line-drawer.ts:27`: `LINE_DRAWER_STAGES = ["intake", "review",
  "decide"]`; the docblock at `:18-26` names Shipped as a navigator - that
  prose is now wrong and changes with the code. `"shipped"` is already a
  `LineStageId` (`src/shared/line.ts:26`), so `isLineDrawerStage` narrows it
  by construction.
- `LineDrawer.tsx:28-32` `DRAWER_GLYPHS` is `Record<LineDrawerStage, string>`:
  adding the stage is a compile error until `shipped: "⚑"` (the strip's own
  glyph) is added. The frame provides title from `LINE_STAGE_LABELS`
  ("Shipped" exists), the `actions` slot, and the close button; bodies render
  rows, never a height.
- Escalation precedent: every drawer's "→" button lives in the `actions` slot
  (`ReviewDrawer`'s "All runs →"). The mockup drew a footer; the repository's
  answer is the actions slot (index finding 2).
- Fetch precedent: `IntakeDrawer.tsx:89-105` - once on mount, three states
  (loading / failed / data) because `fetchJson` resolves null on failure;
  `e2e/specs/line-drawers.spec.ts:269-306` is the regression spec for exactly
  that, and this drawer inherits the hazard.
- Row shape: `ReviewDrawer` rows - `ul.line-drawer-rows > li` at fixed
  `--line-drawer-row-h: 58px`, column spans in grouped selector lists
  (`.line-run-who, .line-ens-who, .line-intake-who { width: 240px }` etc.,
  `styles.css:14638-14753`). A `line-ship-*` family is ADDED TO those grouped
  lists, not a parallel block. The `@media (max-width: 1180px)` rule at
  `:14757-14762` hides the state column; include the new one.
- `src/web/lib/line-targets.ts:46-49` flips to
  `{ kind: "drawer", stage: "shipped" }`; the stale four-line comment above it
  ("No PR list surface exists anywhere in the app") is deleted.
  `lineStageHasDrawer` then reports it automatically (`aria-expanded`).
- App wiring: import beside the other drawers (`App.tsx:29-33`), a fourth
  `lineDrawer === "shipped"` branch (`:2258-2299`). The route-leave effect at
  `:821-823` already closes the drawer when the escalation navigates - rely on
  it, do not duplicate.
- Pinned tests that MUST change with the flip:
  `test/line-drawer.test.ts:96` (`deepEqual` of `LINE_DRAWER_STAGES`),
  `:104-111` (the "re-homed routes" test asserting shipped is a route - the
  premise itself dies), `:397-416` (the frames array gains the Shipped
  drawer). The agreement loop at `:97-101` adjusts by construction.
- e2e that pins the OLD behavior: `e2e/specs/line-strip.spec.ts:138-144`
  observes "clicking the Shipped stage navigated to #/runs?status=completed",
  and that OBSERVED line is baked into the committed
  `docs/evidence/line-strip/transcript.txt`, quoted in `e2e/README.md:236`.
  Both the spec and the evidence transcripts are regenerated
  (`MC_E2E_EVIDENCE=1`, `--workers=1`, the command in `e2e/README.md`); the
  drawers evidence block at `e2e/README.md:245-267` gains the frame and its
  counts change.
- README `## The Line` section: the click-target table row for `⚑ Shipped`
  (`README.md:4286-4297`) currently explains the runs route - replaced. The
  stage-drawers claim at `:4323-4325` ("None of them fetches") is already
  false for Intake and now for Shipped - corrected here while the section is
  open. The per-drawer table (`:4327-4331`) gains the Shipped row.

## 5. Implementation steps

1. `line-drawer.ts`: append `"shipped"`; rewrite the docblock (three of six ->
   four of six; Shipped no longer a navigator).
2. `LineDrawer.tsx`: `shipped: "⚑"`.
3. New `src/web/components/line/ShippedDrawer.tsx`:
   - Once-on-mount fetch via `fetchInspectorPrs(now - 7 days)` (the strip
     count's window, so drawer and strip agree by construction), three-state.
   - Header: `count` = `${rows.length} this week` (singular/plural per the
     other drawers); `actions` = "Ship log →" button calling
     `onOpenShipLog`.
   - Chips: All / Merged / Open / Gone from the `pr-standing` coarse mapping,
     with counts; filter state local to the drawer.
   - Rows: state icon + text label (merged / open / gone - never color
     alone), `PrLink` with title (branch fallback), `SessionRef` when
     `sessionId` present, relative adopted/merged time. Fixed 58px rows;
     `LineDrawerEmpty` for the empty week; failed state distinct from empty.
4. `styles.css`: `line-ship-*` columns appended to the grouped selector lists
   (who / chips / state / ops) and the narrow-viewport rule; chip styles
   reuse the drawer's existing vocabulary.
5. `line-targets.ts`: the flip; delete the stale comment.
6. `App.tsx`: import; fourth branch passing `onClose={closeLineDrawer}` and
   `onOpenShipLog={() => navigate({ page: "shipped" })}`.
7. Tests (`test/line-drawer.test.ts`): update the three pinned sites; add the
   Shipped drawer to the frames loop; replace the "re-homed routes" test with
   one asserting the shipped target is the drawer (and that no stage routes to
   `page: "runs", status: "completed"` anymore, so the old spelling cannot
   quietly return).
8. e2e: extend `e2e/specs/line-drawers.spec.ts` (fourth drawer: open / close /
   swap / esc; chip filtering; failed-read 500 state; escalation click ->
   `toHaveURL(/#\/shipped$/)` + the "Ship log" heading + strip and drawer did
   not follow - the `:383-397` shape). Update `line-strip.spec.ts` to observe
   the drawer instead of the navigation. Seed real rows via the hook-ingest
   adoption signal (index finding 5); use route fulfillment for title-present
   rendering.
9. Regenerate the evidence transcripts (`MC_E2E_EVIDENCE=1`) for line-strip
   and line-drawers; update `e2e/README.md`'s evidence block counts and
   quoted lines.
10. README: click-target table row, the per-drawer table row, and the
    corrected "fetches" sentence for the stage drawers.

## 6. Data, API, and compatibility

Client-only. The drawer reads Phase 1's windowed endpoint through Phase 2's
fetch helper. No schema, route, or SSE change.

## 7. Tests and verification

`npm run typecheck`, `npm run lint`, `npm test`,
`npm run build && npm run smoke`, `npm run test:e2e` (updated line-strip +
extended line-drawers + any new spec), evidence regeneration per step 9.

## 8. Merge and exit criteria

- Section 7 green in CI; the committed evidence transcripts match the new
  behavior (no stale "#/runs?status=completed" observation anywhere).
- Clicking Shipped opens the drawer; `aria-expanded` reports it; escalation
  lands on `#/shipped`; README matches.
- Phase 1 and 2 contracts unchanged (no diff under `src/server/`, no change
  to `pr-standing.ts` exports or the route union beyond consuming them).

## 9. Downstream handoff

None - this is the final phase. The end state is the source plan's approved
behavior; anything further (per-PR cost, the merge matrix module) was
explicitly not adopted and starts as a new plan.

## 10. Cross-phase audit record

- 2026-08-02: written third. Verified against Phase 2's handoff (route,
  heading, helper module, fetch signature) and Phase 1's fallback rule. The
  drawer's 7-day window deliberately mirrors the strip's `prsThisWeek` window
  so the two counts share one provenance (`adopted_at`), per Phase 1's
  documentation of `prsOpenedSince`.
