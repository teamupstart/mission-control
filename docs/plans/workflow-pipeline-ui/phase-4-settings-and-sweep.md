# Phase 4 - Settings placement and final sweep

## 1. Outcome

Workflow settings live where every other subsystem's settings live - a Settings page category,
discoverable by settings search - and the migration's leftovers (orphaned CSS, dead components,
stale strings) are gone. This closes the review's "parallel settings surface" finding.

## 2. Entry criteria and dependencies

- Direct prerequisite: Phase 3 merged (the sweep must see the final shape of both new surfaces).

## 3. Scope

1. A `workflows` Settings category replacing the floating `WorkflowConfigPanel` drawer.
2. The Workflows page header links to it.
3. Final sweep: orphaned styles, dead components, remaining `window.confirm`s under
   `src/web/workflows/`, README consolidation.

Non-goals: changing any workflow config semantics or server routes; the AGENTS.md documentation fix
noted below is a one-line correction, not a rewrite.

## 4. Repository findings and inherited contracts

- The settings registry lives in `src/web/lib/settings-registry.ts` (`SETTINGS_CATEGORIES`,
  grouped contiguously in `SETTINGS_GROUPS` order) with the render switch `renderCategory` in
  `src/web/components/SettingsPage.tsx:346` and per-category panels as sibling components
  (`ForemanSettingsPanel.tsx` et al). **Discrepancy recorded**: AGENTS.md still says the registry is
  "`SETTINGS_CATEGORIES` in `SettingsModal.tsx`" - that file no longer exists (settings became a
  page in #207). Fix the AGENTS.md sentence in this phase.
- Control rows carry `data-anchor="<category>/<slug>"`; `settings-sidebar-render.test.ts` pins nav
  count = array length, contiguous grouping, and anchor validity; the search palette consumes
  `keywords` and the anchor index (`settings-search.ts`).
- `WorkflowConfigPanel.tsx` owns: the Live-delivery toggle, the repo allowlist (via `resolveRepo`),
  retention fields with a shortening confirm (`window.confirm`), and the health grid loaded from
  `/api/workflows/status`. Server routes are reused unchanged.
- Inherited: `workflowConfirm` overlay (phase 2) for the retention-shortening confirm; the page
  header area where the drawer trigger sits (`WorkflowPage.tsx:92`).

## 5. Implementation steps

1. **Registry entry.** Append a `workflows` category to `SETTINGS_CATEGORIES` (label "Workflows",
   blurb naming Live delivery + retention, group beside Foreman/Inspector in the automation group,
   scope `home`, keywords: "workflow", "live delivery", "allowlist", "retention", "persona",
   "review"). Placement must keep the grouping contiguous.
2. **Panel.** New `src/web/components/WorkflowSettingsPanel.tsx` carrying the drawer's content:
   Live toggle (app toggle-row style, not a bare checkbox), repo allowlist rows, retention fields
   (shortening confirm through the `workflowConfirm` overlay), health grid. Each control row gets a
   `data-anchor="workflows/<slug>"`. Add the `case` in `renderCategory`.
3. **Page link.** Replace the drawer trigger in `WorkflowPage.tsx` with a link that navigates to
   the settings page's `workflows` category (the same navigation the settings hash route already
   supports). Delete `WorkflowConfigPanel.tsx`.
4. **Sweep.** Grep `styles.css` for every class removed across phases 2-4
   (`workflow-config-*`, `workflow-connect-*` if the graph-mode dialog was renamed, replaced
   `workflow-*` panel rules, `persona-error` uses outside the Persona library) and delete orphaned
   rules; confirm no `window.confirm` remains under `src/web/workflows/`; fix the AGENTS.md
   settings-registry sentence; README: Workflows configuration under Configuration, drawer
   references removed.
5. **Search.** Verify the new anchors surface in the settings search palette (its index derives
   from the registry + anchors; extend `settings-search.ts` fixtures if it keeps a hand-kept list).

## 6. Data/API/migration

None. `/api/workflows/config` and `/api/workflows/status` are consumed unchanged; the config blob
shape does not move.

## 7. Tests and verification

- `settings-sidebar-render.test.ts` passes with the new category (count, grouping, anchors).
- New `workflow-settings-panel.test.ts`: renders the panel; asserts the Live toggle, allowlist,
  retention and health rows and their anchors.
- Settings search test extended: "retention" and "live delivery" hit the workflows category.
- `git grep -n "workflow-config" src/web/styles.css` returns nothing; `git grep -n "window.confirm"
  src/web/workflows` returns nothing.
- Full suite + build on Node 24/26.

## 8. Merge and exit criteria

- The drawer is gone; the category renders and is searchable; the page header links to it.
- No orphaned CSS or dead workflow components remain; AGENTS.md registry pointer corrected.

## 9. Downstream handoff

None - final phase. The end state matches the source plan with no undocumented cleanup owed.

## 10. Cross-phase audit record

- 2026-07-25: retention-shortening confirm routed through phase 2's `workflowConfirm` overlay
  rather than a new mechanism; AGENTS.md discrepancy (SettingsModal.tsx -> settings-registry.ts /
  SettingsPage.tsx) recorded here as the owning phase.
