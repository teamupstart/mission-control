# Phase 4 - Drawers and re-homing

## 1. Outcome

The Line's stages open drawers in place, and execution views leave the Workflows page for good:

- **Drawers** (Review, Decide, Intake): a stage click opens the drawer between the strip and the
  board, pushing the board down; a second click on the same stage, `esc`, or a ✕ button closes it
  and the board returns; clicking a different stage swaps content in place. Drawers are hard-capped
  at three rows (~38vh) and scroll internally - they never fill the viewport. Session cards render
  at full size in every state.
- **Review drawer:** one row per live run - session, workflow name + version, round, a compact
  pipeline (checks → reviewers → action → Inspector chips), action waits called out, ensemble
  handoff provenance, and an "Open run" affordance. Header: "Bind a workflow…", "All runs →", ✕.
- **Decide drawer:** the condensed decision dossier reusing the strategy result renderers, with
  "Open full dossier" and "Decide" escalation.
- **Intake drawer:** missions and sources with health lines.
- **Re-homing:** full views move to `#/runs[/:id]` and `#/ensembles[/:id]`; every
  `#/workflows/*` spelling redirects permanently; the interim two-tab Workflows page retires; the
  Library's per-shelf cross-links retarget to the new routes.

Visual reference: `docs/mockups/automation-prominence-2/1-library-line.html`, Frame A drawer and
design notes 02/05.

## 2. Entry criteria and dependencies

- Direct prerequisites: **phase 2** (Library exists; interim two-tab page is the retirement
  target) and **phase 3** (strip, `line_summary`, stage ids, click-target mapping point).
- Entry state: both merged to `main`.

## 3. Scope and non-goals

In scope: drawer host + three drawers, drawer keyboard semantics scoped to the fleet page, route
re-homing with permanent redirects, Workflows page retirement, Library cross-link retargeting,
README updates (drawer semantics, route table).

Non-goals:

- No new run/ensemble capabilities: drawers are triage projections of `WorkflowRunSummary` /
  `EnsembleSummary`; every mutation stays on the full pages (run actions, decisions).
- No Working/Backlog/Shipped drawers beyond navigation (they keep phase 3's click targets;
  adding more drawers later is additive).
- No palette work (phase 5).
- No changes to the run reader or ensemble detail internals - they re-mount under new routes.

## 4. Repository findings and inherited contracts

- Runs UI: `WorkflowRuns.tsx` (rail + reader), pure rules in `run-model.ts`
  (`reviewerStatus`, `checkStatus`, `sessionActionStatus`, `runStatusLabel`), `RunPipeline.tsx`,
  shared leaves `pipeline-bits.tsx` (`PipelineStatusChip`, `ReviewerRow`, `StageCard`) and the
  compact `WorkflowLadder.tsx` - the Review drawer rows compose from these, not new leaves.
- Ensembles: `EnsembleRuns.tsx` (SSE-driven list; only selected run fetches detail),
  `EnsembleDetail.tsx`, `results/index.ts` `ENSEMBLE_RESULT_RENDERERS`, `DecisionPanel.tsx`,
  `dossier.tsx` - the Decide drawer reuses the renderer registry with a condensed context flag if
  needed.
- Router: phase 2's `MissionRoute` with the `library` family; `runId`/`ensembleId`/`filters`
  route params exist today under the `workflows` page and translate to the new top-level routes.
- Keyboard: `esc` layering must respect existing overlay precedence (modals, palette) - the
  drawer closes only when it is the topmost surface.
- Inherited contracts: `line_summary` stage ids and the click-target mapping point (phase 3);
  library route family and cross-link locations (phase 2); the chip-owned topbar right (phase 1,
  untouched).

## 5. Implementation steps

1. Router: add `{ page: "runs", runId?, filters? }` and `{ page: "ensembles", ensembleId? }`
   variants; parse/serialize `#/runs[...]`, `#/ensembles[...]`; legacy `#/workflows/runs*` and
   `#/workflows/ensembles*` parse to the new routes (redirect-on-parse, permanent). Delete the
   `workflows` page variant once nothing renders it.
2. Re-mount `WorkflowRuns` and `EnsembleRuns` under the new pages in `AppPageShell`/`App.tsx`;
   retire `WorkflowPage.tsx` and its tab strip; keep the ensembles attention badge by moving it
   to the Line's Decide stage (already amber via folds) and the topbar if previously surfaced.
3. Drawer host on the fleet page: state = open stage id or null; renders below the strip, above
   the layouts; CSS `max-height` cap (three rows ≈ 38vh) with internal scroll; open/close/swap
   per decision 5; focus management (focus moves into the drawer on open, returns to the stage
   button on close).
4. Review drawer rows from `WorkflowRunSummary` (+ `run-model` helpers); provenance chip for
   `externalSource` runs; "Open run" → `#/runs/:id`; "All runs →" → `#/runs`;
   "Bind a workflow…" opens the existing binding dialog.
5. Decide drawer from `EnsembleSummary` + condensed renderer; "Decide" and "Open full dossier" →
   `#/ensembles/:id`.
6. Intake drawer from schedule/source folds; links to their surfaces.
7. Swap phase 3's interim click targets to drawers for review/decide/intake; working/backlog/
   shipped keep navigation targets.
8. Library cross-links retarget to `#/runs` / `#/ensembles`.
9. README: drawer semantics (toggle, `esc`, ✕, cap + scroll), final route table, retirement note.
10. Tests:
    - `test/`: route codec (new pages + every legacy redirect spelling); drawer reducer
      (open/toggle/swap/close) as pure logic; `renderToStaticMarkup` for drawer row shape.
    - e2e `e2e/specs/line-drawers.spec.ts`: click Review opens the drawer (board still present
      below, cards intact); second click closes; `esc` closes; ✕ closes; clicking Decide swaps;
      with >3 seeded runs the drawer scrolls internally (assert bounded height + scrollability);
      "Open run" lands on `#/runs/:id`; legacy `#/workflows/runs/:id` and
      `#/workflows/ensembles/:id` deep links redirect; the old Workflows page is gone from nav.
    - Electron geometry: drawer-open fleet height expectations.

## 6. Data / API / migration

No server API or DB changes. Client route migration with permanent redirects; bookmarks and any
stored deep links keep resolving.

## 7. Verification

`npm run typecheck && npm run lint && npm test`; `npm run build && npm run smoke`;
`npm run test:e2e`; `npm run test:electron` on macOS. Manual: full drawer semantics against the
mockup; every legacy deep-link spelling; run actions and ensemble decisions still work on the
re-homed full pages.

## 8. Merge and exit criteria

- Three drawers live with cap/scroll/toggle semantics; cards untouched in every state.
- `#/runs` and `#/ensembles` are the only execution routes; all legacy spellings redirect;
  `WorkflowPage` deleted.
- All checks green; README matches.

## 9. Downstream handoff

Later phases may rely on: the final route table (`#/library`, `#/runs`, `#/ensembles`, redirects),
drawer host presence, and stage → drawer mapping. Later phases must not: reintroduce execution
tabs into the Library or grow drawers past the cap.

## 10. Cross-phase audit record

- 2026-08-02: drafted against `81fd089`. Consumes phase 2's interim two-tab page as its retirement
  target and phase 3's click-target mapping point; both named in those files' handoffs. Confirmed
  the ensembles attention badge relocation (tab strip → Decide stage tone) so no attention signal
  is lost when the tab strip retires.
