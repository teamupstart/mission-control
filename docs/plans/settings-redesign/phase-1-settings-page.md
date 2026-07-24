# Phase 1: Settings page container and grouped registry

Source plan: `docs/plans/settings-redesign/plan.md` (requirements R1-R7, decisions D1,
D2, D7). Visual target: `docs/plans/settings-redesign/prototype.html` (the page shell,
rail, and Task sources master-detail; ignore the Trust category, harness cards, dots,
and palette - later phases own those).

## Outcome

Settings is a routed page (`#/settings/<category>`) with a rail grouped by blast radius
and scope badges, replacing the modal. Layout + Appearance merge into one Display
category. Task sources renders master-detail at page width. Every panel keeps its exact
behavior and copy; this phase changes the container and the registry, not the panels'
contracts.

## Entry criteria and dependencies

- Depends on: nothing (first phase).
- Entry: clean main; `npm run typecheck && npm test` green.

## Scope

In: route, page component, grouped registry, modal retirement, Display merge, Task
sources master-detail layout, `data-anchor` convention, CSS section, README, tests.

Non-goals: Trust category (Phase 2), harness cards (Phase 3), status dots and any SSE
change (Phase 4), search palette and the control-level index including the rail search
box (Phase 5 - a search box that does nothing would lie, so the rail ships without one
until the palette exists), any change to what a panel says or writes.

## Repository findings this phase builds on

- Routing lives in `src/web/workflows/useWorkflowRoute.ts`: `MissionRoute` is
  `{ page: "fleet" } | { page: "workflows"; tab }`, with `parseMissionRoute` /
  `missionRouteHash` and a dirty-draft gate. `App.tsx` renders through
  `AppPageShell` (`page: "fleet" | "workflows"`), and its fleet key handler already
  stands down via `if (route.page === "workflows") return;` (App.tsx ~line 623).
- Settings today: `SettingsModal.tsx` with `SETTINGS_CATEGORIES` (11 entries, data-only
  registry), opened by `settingsOpen`/`settingsCategory` state in `App.tsx` (~113-117),
  the topbar gear (~942), ForemanBar's deep-link (~918), and the native menu over the
  `mission:open-settings` IPC channel (`src/main/index.ts` `openSettings()`,
  `src/preload/index.ts` `onOpenSettings`). The IPC surface is reused unchanged; only
  App's listener body changes (D1) - this is deliberately NOT an Electron 4-file change.
- The modal registers as `OVERLAY_IDS.settings` (`src/web/components/Overlay.tsx`);
  `overlay-registry.test.ts` walks that list. `App.tsx` has a "session disappeared"
  reconciliation effect for session-bound overlays - settings is not session-bound, no
  action needed there.
- `useSkills`/`useHarnesses`/`useInspector`/`useShipping`/`useTaskSources` are
  instantiated inside `SettingsModal` so they poll only while it is open (documented
  intent). `foreman`, `cost`, `llm`, and `layout` are owned by App and passed in; keep
  that split exactly.
- Tests that pin today's shape: `settings-sidebar-render.test.ts` (nav count equals
  registry length; every category reachable via `initialCategory`),
  `overlay-registry.test.ts`, `keybindings.test.ts`.
- `styles.css` sections involved: "settings (topbar gear + keybindings editor)" (~4677),
  the modal rules `.settings-modal`/`.settings-layout`/`.settings-nav*` (~5303-5390),
  and the Task sources section (~5661). The file has no unused-CSS check: grep every
  removed class name.

## Implementation steps

1. **Route** (`src/web/workflows/useWorkflowRoute.ts` - keep the file; it is the one
   mission router despite the name):
   - `MissionRoute` gains `{ page: "settings"; category: SettingsCategoryId }`.
   - `parseMissionRoute`: `/settings` → default category `"display"`;
     `/settings/<id>` → that category when it is in `SETTINGS_CATEGORIES`, else the
     default. `missionRouteHash` emits `#/settings/<category>`.
   - Import type only from the settings registry to avoid a cycle (registry is
     data-only).
2. **Registry** (in the settings page module): `SETTINGS_CATEGORIES` entries gain
   `group: "screen" | "sessions" | "background" | "outbound"`,
   `scope: "browser" | "machine" | "home" | "github"`, and `keywords: string[]`
   (keywords may start minimal; Phase 5 consumes them). Add an ordered
   `SETTINGS_GROUPS` registry (id, label, scope) - groups render from it, never from a
   hand-kept list in JSX. Remove the `appearance` entry; `display` replaces `layout`
   (Display renders LayoutPanel + AppearancePanel stacked). `SettingsCategoryId` remains
   the derived union. Category ids are not persisted anywhere; renaming `layout` →
   `display` is safe (verify with a repo-wide grep for `"layout"` as a category id -
   note `LayoutMode` and the `LAYOUTS` registry are unrelated and untouched).
3. **Page component**: new `src/web/components/SettingsPage.tsx` (move + rework of
   `SettingsModal.tsx`; delete the modal file). Keeps: tablist semantics, roving
   tabindex, arrow/Home/End handling, `renderCategory` switch, the five page-owned
   hooks, and the App-owned props (`foreman`, `cost`, `llm`, `layout`,
   `onLayoutChange`). Changes: no `Overlay` wrapper; rail renders `SETTINGS_GROUPS` →
   member categories with scope badges; a panel header row per category showing its
   scope badge; active category comes from the route prop, selection calls
   `onNavigate(category)`.
4. **App.tsx**: drop `settingsOpen`/`settingsCategory`; `AppPageShell` gains the
   `"settings"` page and slot; gear/ForemanBar/`onOpenSettings` listener navigate to
   the settings route (gear → default category, ForemanBar → `foreman`); the fleet key
   handler stands down for any `route.page !== "fleet"`; Escape inside the settings
   page (not in an input/textarea/select, no palette yet) navigates to the fleet -
   implement in the page, mirroring how the Workflows page owns its keys.
5. **Task sources master-detail** (`TaskSourcesPanel.tsx`): replace the
   directory→editor back-stack with side-by-side columns per the prototype (directory
   list + always-visible editor for the selected source; `showAdd` becomes an inline
   affordance). State hooks, commit-on-blur draft handling, the stale-closure guard,
   and every action (`sweep`, `preflight`, `forget`) are unchanged. Keep the
   focus-restore behavior when a selection disappears mid-poll.
6. **Anchors**: every control row across all panels gets
   `data-anchor="<category>/<slug>"` (e.g. `shipping/soak`, `cost/track`). Document the
   convention where `SETTINGS_CATEGORIES` is defined: anchors are stable ids consumed
   by Phase 5's search index; renaming one is a breaking change to that index.
7. **CSS**: new `/* ---- settings page ---- */` section; retire
   `.settings-modal`/`.settings-layout` rules; keep or rename `.settings-nav*` and the
   shared row/section classes. Grep `styles.css` for every removed/renamed class in the
   same change. The page is a full-height sibling of the workflows page in console and
   board layouts - reuse the `.app-console > .workflow-page` pattern for overflow.
8. **README**: settings section rewritten (page, groups, scope badges, deep links,
   Escape-to-fleet, `⌘,` behavior); shortcut table only if any binding text changes
   (none expected this phase).

## Data / API / migration

None. No daemon change, no schema change, no persisted key changes (layout mode and
rich-text keys in localStorage are untouched).

## Tests and verification

- Rework `settings-sidebar-render.test.ts` → render `SettingsPage` statically: rail
  button count equals `SETTINGS_CATEGORIES` length; every category id renders its panel
  when passed as the active route; every group in `SETTINGS_GROUPS` is non-empty and
  every category belongs to exactly one group; every rail item shows its group's scope
  badge.
- New `settings-route.test.ts`: `parseMissionRoute`/`missionRouteHash` round-trips for
  `#/settings`, `#/settings/shipping`, unknown category fallback, and the existing
  fleet/workflows cases unchanged.
- Update `overlay-registry.test.ts` for the removed settings overlay id.
- New anchor uniqueness assertion (can live in the render test): collect all
  `data-anchor` values from a full render across categories; assert no duplicates and
  every anchor's prefix is a real category id. This is the Phase 5 contract, pinned
  from day one.
- `npm run typecheck && npm test && npm run build`; manual pass per README "Verifying"
  (own vite port; check all three layouts host the page correctly; gear, `⌘,` in the
  desktop shell, ForemanBar link, browser back/forward through settings hashes).

## Merge and exit criteria

- Modal gone; page reachable from gear, menu, hash, and ForemanBar; all panels
  functionally identical (except the Task sources layout and the Display merge); CI
  green.

## Downstream handoff (later phases rely on; do not change)

- `MissionRoute`'s settings variant shape and hash grammar.
- `SETTINGS_CATEGORIES` entry shape `{ id, label, icon, group, scope, keywords }` and
  the ordered `SETTINGS_GROUPS` registry.
- The `data-anchor="<category>/<slug>"` convention and its uniqueness test.
- `SettingsPage` owns the five category-scoped hooks and receives App-owned state as
  props; panels receive state, never re-instantiate hooks.
- The page's key handling owns Escape; Phase 5's palette will layer above it.

## Cross-phase audit record

- 2026-07-23: initial version. Reviewed against plan decisions D1/D2/D7 and later-phase
  needs (anchors for Phase 5, group registry for Phases 2/5, prop-owned foreman state
  for Phase 2's Trust writes). No conflicts.
