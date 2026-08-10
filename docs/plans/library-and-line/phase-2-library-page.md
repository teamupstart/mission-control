# Phase 2 - The Library page

## 1. Outcome

A new top-level page, `#/library`, becomes the only home for authored, reusable assets. The topbar
gains a segmented page nav (`▦ Fleet` / `⌗ Library`); the page-toggle chord (today's `w`) toggles
Fleet ⇄ Library. The Library renders five shelves, each headed by the question it answers with the
system noun as a mono eyebrow: Workflows ("What counts as done?"), Personas ("Who does the
reviewing?"), Actions ("What can a run tell the session to do?"), Ensembles ("Not sure of the best
approach?" - strategy launchers only), and Missions · Sources ("Where does work come from?"). The
Workflows page's three authoring tabs redirect here; its `runs` and `ensembles` tabs remain, as a
two-tab execution page, until phase 4 re-homes them.

Visual reference: `docs/archive/mockups/automation-prominence-2/1-library-line.html`, Frame B.

## 2. Entry criteria and dependencies

- Direct prerequisites: none (concurrent with phases 1 and 3).
- Entry state: `main` with `docs/plans/library-and-line/` present.

## 3. Scope and non-goals

In scope:

- `MissionRoute` union gains `{ page: "library", shelf?, assetId? }` variants sufficient to
  deep-link a shelf and an open editor; hash parse/serialize round-trips.
- The Library page: shelves, question headers, asset cards with live-usage facts already available
  from SSE stores (workflow summaries, persona/action lists), per-shelf "on the Line →" cross-link
  (until phase 4 exists, these links target the surviving runs/ensembles tabs; phase 4 retargets).
- Asset cards open the existing editors one level deeper, unchanged: the workflow builder
  (`WorkflowLibrary` + editors), `PersonaLibrary`/`PersonaEditor`, `SessionActionLibrary`/
  `SessionActionEditor` mount under Library routes.
- Ensembles shelf: three strategy launcher cards (from `ENSEMBLE_STRATEGY_IDS` metadata) that open
  the Dispatch modal with ensemble mode and the strategy preselected.
- Missions · Sources shelf: cards summarizing existing schedules and task sources, linking to
  their current surfaces; no ownership migration.
- Redirects: `#/workflows` → `#/library`; `#/workflows/personas` → Personas shelf;
  `#/workflows/actions` → Actions shelf. The Workflows page keeps only `runs` and `ensembles`
  tabs; its tab strip shrinks accordingly.
- Page-toggle chord retargeted; dirty-draft guard preserved for editors now mounted under Library.
- README: Library section; updated navigation/shortcut docs.

Non-goals:

- No Line strip, drawers, or `#/runs`/`#/ensembles` routes (phases 3-4).
- No new live-state event; shelf cross-links use counts already present in SSE stores or none.
- No Settings migration for skills/harnesses/sources beyond links.
- No cost chip changes (phase 1 owns the topbar right side).

## 4. Repository findings and inherited contracts

- `src/web/workflows/useWorkflowRoute.ts`: `MissionRoute` union and hash codec; `workflowsToggleRoute`
  is the pure chord function with guards (typing/renaming/overlay/dirty-draft). The dirty-draft gate
  lives in this router and must keep guarding editors after they re-home.
- `src/web/workflows/WorkflowPage.tsx`: `WORKFLOW_TABS` (5 tabs + hints), ensembles attention badge,
  "Workflow settings →" link. After this phase it renders only `runs`/`ensembles`.
- `src/web/components/AppPageShell.tsx`: one page mounts at a time; the Library becomes a third
  peer of fleet/settings/workflows.
- Editors and their stores are self-contained components already mounted by tab id; they take no
  route knowledge beyond selection ids (verified in `WorkflowLibrary.tsx`, `PersonaLibrary.tsx`,
  `SessionActionLibrary.tsx`).
- Dispatch: `DispatchModal.tsx` `launchMode: "single" | "ensemble"`; `EnsembleDispatch.tsx` +
  `dispatch/config.ts` (`defaultConfigFor`) accept a strategy default.
- Keyboard: bindings live in `src/web/lib/keybindings.ts`; the toggle key resolves through the
  ACTIONS registry.
- Inherited contracts: topbar ownership split with phase 1 (P1 right side, P2 left side segment);
  do not touch the cost surface.

## 5. Implementation steps

1. `useWorkflowRoute.ts`: add the `library` page variants + hash codec (`#/library`,
   `#/library/personas`, `#/library/actions`, `#/library/workflows/:id`, etc. - exact segment
   naming is the implementer's choice, recorded in the README); rework `workflowsToggleRoute` to
   toggle Fleet ⇄ Library with the same guards; legacy parse of `#/workflows`,
   `#/workflows/personas`, `#/workflows/actions` returns the corresponding library route
   (redirect-on-parse, permanent).
2. `src/web/library/LibraryPage.tsx` (new): shelf layout per the mockup (question `h3`, eyebrow,
   why-sentence, card grid, "New" affordances); accessible landmarks (`aria-label` per shelf);
   search input placeholder wired to existing behavior only if trivial (the everything-palette is
   phase 5 - a static filter over shelf cards is acceptable, or omit).
3. Mount editors under Library routes; move tab-content composition out of `WorkflowPage.tsx` where
   needed. Preserve autosave/undo/CAS behavior (`useWorkflowDraft`) and the dirty-draft navigation
   gate.
4. `WorkflowPage.tsx`: reduce `WORKFLOW_TABS` to `runs` + `ensembles`; keep the attention badge and
   settings link; title copy reflects execution-only interim state.
5. `App.tsx`: topbar left gains the Fleet/Library segment (role navigation, `aria-current`);
   `AppPageShell` learns the library page.
6. Ensembles shelf launchers: open `DispatchModal` with `launchMode: "ensemble"` and
   `defaultConfigFor(strategy)`.
7. README: Library section, route table, shortcut updates.
8. Tests:
   - `test/`: route codec round-trips (legacy → library redirects included); toggle-route pure
     function cases; `renderToStaticMarkup` shape for shelf headers (question + eyebrow).
   - e2e `e2e/specs/library.spec.ts`: topbar segment navigates; shelves render with question
     headings; a workflow card opens the builder; a persona card opens the editor; an action card
     opens the editor; legacy `#/workflows/personas` deep link lands on the Personas shelf;
     strategy card opens Dispatch in ensemble mode; the Workflows page shows only runs/ensembles
     tabs.

## 6. Data / API / migration

None. No server routes, no DB, no new events. Pure client IA plus redirects.

## 7. Verification

`npm run typecheck && npm run lint && npm test`; `npm run build && npm run smoke`;
`npm run test:e2e` including the new spec. Manual: every legacy authoring deep link redirects;
editors keep drafts across navigation exactly as before.

## 8. Merge and exit criteria

- `#/library` live with five shelves; editors fully functional under it.
- Legacy authoring routes redirect; runs/ensembles tabs still work untouched.
- Toggle chord switches Fleet ⇄ Library with all existing guards.
- All checks green; README matches.

## 9. Downstream handoff

Later phases may rely on: the `library` route family and its hash spellings as published in the
README; the Fleet/Library segment; the two-tab interim Workflows page; strategy launcher →
Dispatch wiring. Later phases must not: move editors again, rename library routes, or add live
execution state into Library shelves beyond cross-links (phase 4 retargets those links to
`#/runs` / `#/ensembles`).

## 10. Cross-phase audit record

- 2026-08-02: drafted against `81fd089`. Interim two-tab Workflows page named as a valid shipped
  state; phase 4 owns its retirement. Topbar split with phase 1 confirmed (segment left, chip
  right) so the phases merge in either order.
