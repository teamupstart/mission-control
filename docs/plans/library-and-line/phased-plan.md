# The Library and the Line - phased implementation

Source plan: `docs/plans/library-and-line/plan.md` (rendered: `plan.html`). The operator's
submitted decisions are recorded there as requirements; the follow-up decision was "create phased
implementation plan, schedule the phases, PR the artifacts, merge on green CI".

## Incorporated decisions

1. One product: Library (authoring home) + Line (execution surface on the Fleet).
2. Runs and Ensembles re-home to `#/runs` and `#/ensembles`; they are never Library shelves.
   Strategy launchers shelve in the Library.
3. Session cards unchanged in data, layout, and size, in every state.
4. UsageBar row retired for a cost chip + spend popover; `FleetCost` wire contract unchanged.
5. Drawers: toggle semantics (same-stage click / `esc` / ✕ close; different stage swaps), hard cap
   of three rows (~38vh), internal scroll, board pushes down and returns.
6. The everything-palette is the final phase.

## Investigated findings

Verified against the repository at branch point (`github/main`, `81fd089`):

- `MissionRoute` is the single router union (`src/web/workflows/useWorkflowRoute.ts`):
  `fleet | workflows(tab: workflows|personas|actions|runs|ensembles, runId?, ensembleId?, filters?)
  | settings(category)`. `workflowsToggleRoute` implements the `w` chord as a pure function; the
  dirty-draft gate lives in this router. New pages must extend this union, not add a second router.
- `App.tsx` renders `UsageBar` (defined in-file, ~line 2420) as a second row inside
  `<header className="topbar">`, delegating content to `FleetStrip.tsx`
  (`compactFleetCost`, `fleetStripHasContent`, stats + runway meters + automation line). Fold state
  persists via `useUsageBarCollapsed` (`src/web/lib/usageBar.ts`, `app_config.ui.usageBarCollapsed`).
- `useEventStream.ts` handles every `ServerEvent` in one exhaustive switch (controlled path,
  `src/web/useEventStream.ts`); cost arrives as `cost_fleet`. A new `line_summary` event follows the
  `cost_fleet` pattern: server-computed, change-gated, one payload.
- Server folds precedent: `src/server/registry.ts` `fleetEstimatedCostSince` /
  `automationEstimatedCostSince`, change-gated emission (~line 3818). Workflow/ensemble stores
  already project SSE summaries (`WorkflowRunSummary`, `EnsembleSummary`) the Line folds can reuse.
- Runs UI splits controller (`WorkflowRuns.tsx` rail + reader, `run-model.ts` pure rules,
  `RunPipeline.tsx`, shared leaves `pipeline-bits.tsx`) - the Review drawer reuses these leaves.
  Ensemble side: `EnsembleRuns.tsx` controller, `EnsembleDetail.tsx`, strategy renderers under
  `src/web/ensembles/results/` (`ENSEMBLE_RESULT_RENDERERS`), `DecisionPanel.tsx` - the Decide
  drawer reuses these.
- `⌘K` today searches settings only (`src/web/lib/settings-search.ts`, `searchSettings`,
  `buildSettingsBindings`).
- e2e: `e2e/specs/*` with `e2e/fixtures/fake-agents.ts`; specs select by role/label/placeholder,
  never `data-testid`; `npm run test:e2e` needs `npm run build` first. Electron geometry tests
  measure laid-out height on macOS (`npm run test:electron`).
- Discrepancy noted: the mockups draw a filter input on the Fleet topbar and specific counts;
  content is illustrative. Phase files bind to contracts (routes, events, components), not to the
  mockup's sample data.

## Phases

| # | Phase | File | Direct prerequisites |
| --- | --- | --- | --- |
| 1 | Cost chip and spend popover | `phase-1-cost-chip.md` | none |
| 2 | The Library page | `phase-2-library-page.md` | none |
| 3 | Line strip and fold event | `phase-3-line-strip.md` | none |
| 4 | Drawers and re-homing | `phase-4-drawers-and-rehoming.md` | 2, 3 |
| 5 | The everything-palette | `phase-5-everything-palette.md` | 4 |

## Dependency graph and concurrency

```
P1 (cost chip)      ─┐
P2 (library page)   ─┼─▶ P4 (drawers + re-homing) ─▶ P5 (palette)
P3 (line strip)     ─┘        (P4 needs P2 + P3)
```

- **Concurrency group A:** phases 1, 2, 3 are mutually independent and may run concurrently.
  Phase 1 owns the topbar's right side (cost chip); phase 2 owns the topbar's left side (page
  segment) and the router union; phase 3 owns the fleet content area and the new SSE event. The
  only shared file is `App.tsx`; edits are in disjoint regions and merge in any order.
- **P4** requires both P2 (Library exists, so retiring the authoring tabs has a destination) and
  P3 (the strip exists to hang drawers from). P1 is not a prerequisite of anything.
- **P5** requires P4 directly (it indexes both homes and the re-homed routes; P2 and P3 arrive
  transitively).

Merge order within group A is free. P4 merges only after both P2 and P3; P5 only after P4.

## Cross-phase contracts

- **Route names** (owned by P2, extended by P4): `#/library[...]` from P2; `#/runs[/:id]`,
  `#/ensembles[/:id]` and permanent `#/workflows/*` redirects from P4. P5 navigates only to routes
  these phases established.
- **Event name** (owned by P3): `line_summary` with a `LineSummary` payload in `src/shared/`
  (browser-safe, no `node:` imports). P4 consumes it for drawer badges; P5 reads the same store.
- **Chip tone** (owned by P1): the machinery-purple cost chip and popover dialog markup; P3 reuses
  the per-PR figure from `FleetCost.prsToday` on the Shipped stage without new wire contracts.
- **Interim state after P2, before P4:** the Workflows page keeps only its `runs` and `ensembles`
  tabs (authoring tabs redirect to the Library). This is a valid shipped state, named in both
  phase files.
- **Keyboard** (split): P2 retargets the page toggle chord (Fleet ⇄ Library); P4 adds drawer `esc`
  handling scoped to the fleet page; P5 owns `⌘K`.

## Final verification

After P5 merges: `npm run typecheck && npm run lint && npm test`, `npm run build && npm run smoke`,
`npm run test:e2e` (full suite - the five phases each added specs), `npm run test:electron` on
macOS for the strip-height geometry. Manual pass against the mockups: two homes, drawer semantics
(cap, scroll, close paths), redirects from every legacy `#/workflows/*` deep link, cost chip parity
with the retired FleetStrip content, README sections match every shipped surface.
