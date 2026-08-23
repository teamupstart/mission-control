# Phase 1: Reusable tour engine and See-work migration

## Outcome and value

Replace the singular See-work tour implementation with a reusable, registry-driven tour
engine while preserving the existing tour's exact user-visible behavior. After this phase,
Mission Control still shows one tour, but a second definition can be added without creating
another controller, active-run owner, Settings row implementation, palette provider, overlay,
target registry, or server route family.

## Entry criteria and dependencies

- `docs/plans/library-tour/plan.md` and `docs/plans/library-tour/phased-plan.md` are merged on
  the default branch.
- No implementation phase is a prerequisite.
- Work begins from current `main`; re-check the tour controller and App ownership before
  applying filenames proposed below.

Direct dependency: the planning session only.

## Scope

### Included

- Extract a general Driver.js controller and tour-definition contracts.
- Re-express **See the work** as the first definition.
- Support stable stop ids, ordered target beats, targetless stops, stop-based progress, and
  beat-based navigation even though See-work uses one beat per stop.
- Namespace semantic targets by tour while preserving identity-safe registration.
- Generalize App to one active tour with definition-owned runtime/navigation and cleanup.
- Derive Settings and palette tour entries from one registry.
- Generalize overlay ownership and tour CSS.
- Generalize the existing HTTP route family through a server-side tour registry while
  retaining See-work's strict identity checks and fixed dispatch inputs.
- Preserve every See-work fallback, modal interaction, focus trap, cleanup retry, snapshot
  restore, and temporary-draft isolation behavior.

### Explicit non-goals

- Do not add or expose the Library tour.
- Do not instrument Library, Workflow run, or session-ladder targets yet.
- Do not change See-work copy, stop order, temporary prompts, chosen model, task kind, review
  posture, or cleanup outcome.
- Do not add first-run triggering, persisted progress, a top-bar entry, or another overlay.
- Do not add persistence or a migration.

## Repository findings inherited by this phase

- `src/web/tour/SeeWorkTourController.tsx` contains all fragile Driver.js behavior in one
  756-line component. Preserve its comments as contracts, especially intended-step authority,
  delayed target refresh, app-modal focus ownership, immediate-exit cleanup, and cleanup retry.
- App currently starts a tour before calling its first navigation. The generalized start path
  must preflight the definition's first navigation and set active state only when it succeeds.
  `navigate()` remains the dirty-draft authority.
- The existing `MissionRoute` snapshot already includes Library shelf and asset selection.
- The current route bodies intentionally accept only `repoRoot`; the server fixes every other
  launch property.
- `useTourTaskTargetRef` has a hardcoded Extract allow-list for See-work's task-scoped targets.
  Replace that with declared target scope metadata rather than another literal union.

## Proposed implementation route

The filenames are proposed ownership boundaries, not mandatory API spellings. Keep existing
module ownership and adapt if current `main` offers a cleaner seam.

### 1. Define the general contracts and registry

- Add a browser-safe tour contract module under `src/web/tour/` for:
  - `TourId`;
  - namespaced `TourTargetId` and target scope;
  - `TourDefinition`, `TourStep`, stop detail, side, and next-label metadata;
  - ordered `targets` with zero targets only for an intentional centered card and a maximum of
    two targets for ordinary stops;
  - stable stop ids and a cursor containing stop id plus beat index;
  - per-step `prepare`, `ready`, `fallback`, and `reconcile` behavior with typed runtime and
    navigator access.
- Add one tour registry that resolves a definition by id and supplies its ordered metadata to
  App, Settings, and the palette. Reject duplicate tour ids, duplicate stop ids within a tour,
  duplicate target ids within a namespace, more than two beats, and a nonterminal targetless
  stop unless the definition explicitly allows it.
- Re-express the existing 14 See-work stops as a definition without changing their strings or
  ordering.

### 2. Extract `GuidedTourController`

- Move Driver creation, progress header, description rendering, fallback state, focus
  containment, overlay-top handling, reduced-motion behavior, exit, destroy, and cleanup-error
  recovery into one reusable controller.
- Replace index authority with a stable stop id and beat index. Driver's active index remains
  observational; the engine's intended cursor remains authoritative across React refreshes.
- Flatten the definition into Driver screens, but compute progress from the owning stop.
  Back and Next move within beats before moving between stops.
- Keep real-surface interaction available only where the definition declares it. Preserve the
  review and Dispatch modal behavior of See-work.
- Keep centered fallback cards usable with Back, Next, and Exit when a target is absent.
- Keep `onFinish` asynchronous and retryable. A failed cleanup must restore the operator's
  surface, retain resource handles, and let the same controller retry.

### 3. Generalize target registration

- Change `target-registry.ts` from one flat literal tuple to per-tour namespaced groups while
  retaining token-based stale-unmount protection.
- Update `target-context.tsx` so an active tour can declare which task id owns task-scoped
  targets. Do not encode See-work's four task target names in the hook signature.
- Update existing target owners in Line, Board, Dispatch, review, task tile, action row, and
  completion modal to the new namespaced ids.
- Extend focused tests for namespace isolation, Strict Mode replay, latest-owner replacement,
  and task-scope refusal.

### 4. Make App own one active tour

- Replace `SeeWorkTourRun` with a single `TourRun` that stores tour id, unique run id, the
  complete `MissionRoute`, layout/selection/Board/filter/Line snapshot, focus bookmark, and a
  definition-specific resource handle.
- Replace the re-entry guard with one active-tour ref. A second activation of any tour while
  one is active is a no-op.
- Preflight the first route transition before committing active state. If a dirty draft raises
  the existing leave dialog, leave the tour inactive and let the existing route flow own the
  decision.
- Move See-work's preview and demo task ids, repo selection, brief state, navigation adapter,
  runtime derivation, Dispatch preview, and cleanup behind the See-work definition/runtime
  adapter. It may remain App-owned where it consumes App state, but generic App code must not
  branch on future concrete tours outside the registry boundary.
- Restore the complete snapshot and focus by the existing semantic bookmark path.

### 5. Derive discovery and overlay surfaces

- Change Settings from one `onStartSeeWorkTour` prop and hardcoded button to a registry-derived
  tour list and one `onStartTour(tourId)` callback. With one registered definition, current
  markup and accessible text remain equivalent.
- Change the palette target from `start-see-work-tour` to `start-tour` plus `tourId`; derive one
  command row per registry definition and keep it in the Do group.
- Replace `OVERLAY_IDS.seeWorkTour` with one `tour` id.
- Generalize `.mc-see-work-tour` to `.mc-tour` and keep See-work's rendered appearance,
  spotlight flags, reduced-motion rule, and z-index behavior unchanged.

### 6. Generalize server support without widening authority

- Add a server-side registry for tour task recipes and identity checks. Keep prompts and
  Zod schemas in their current browser-safe/shared owners where appropriate; do not import
  server modules into `src/shared/`.
- Route the existing operations through `/api/tours/:tourId/dispatch`,
  `/api/tours/:tourId/preview`, and `/api/tours/:tourId/tasks/:id/complete`.
- Resolve `see-work` to exactly the current fixed recipes. An unknown tour or an operation a
  definition does not support returns a bounded 404/409 and never falls through to general
  dispatch.
- Preserve the title, label, kind, and intent-prefix identity checks before cleanup. Preserve
  SDK-handle reconciliation through `Registry.applyDriverEvent`; do not add an eviction path.
- Update the API client to pass a tour id while retaining typed See-work wrappers if that makes
  the definition adapter clearer.

## Data, API, and compatibility

- No database or persisted-schema change.
- No ServerEvent change.
- The HTTP path changes are internal browser-daemon APIs shipped from one build. Keep the
  `see-work` id literal stable and update tests to prove unknown ids and mismatched tasks fail
  closed.
- Existing See-work task titles, labels, intents, outcome strings, and required MCP tool list
  are compatibility contracts and stay byte-for-byte equivalent.
- Persisted append-only workflow and asset ids are untouched.

## Tests and verification

Add or update focused unit coverage for:

- valid and invalid definitions, stable stop ids, beat flattening, stop-based progress, and
  targetless terminal stops;
- namespaced target isolation and declared task scope;
- one Settings and palette entry derived from the registry;
- palette activation carrying `tourId`;
- generalized HTTP routes, unknown tour refusal, fixed See-work recipes, strict cleanup
  identity, early cancellation, SDK cleanup reconciliation, and retry-safe errors.

Required browser proof:

- Run `e2e/specs/see-work-tour.spec.ts` unchanged. The generalized route still resolves the
  same `/api/tours/see-work/*` URLs, so neither its assertions nor its URL interception need
  to move.
- Prove the Settings row, palette entry, progress count, modal ownership, geometry, focus,
  cleanup retry, temporary Dispatch draft isolation, and restored route still work.

Commands, from repository root with the test preload where applicable:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/tour-target-registry.test.ts \
  test/palette-index.test.ts \
  test/settings-sidebar-render.test.ts \
  test/see-work-tour-http.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/see-work-tour.spec.ts --workers=1
```

## Merge and exit criteria

- One engine and one registry own tour behavior and discovery.
- Only See-work is visible, with the same 14 stops, copy, controls, fallbacks, cleanup, and
  restoration.
- No See-work-only branch remains in Settings, palette, overlay registration, target scope, or
  generic controller code.
- The generalized server route cannot dispatch arbitrary properties or clean up an unrelated
  task.
- Required focused and repository gates pass.
- The pull request documents any deviation from this proposed route and why the current
  repository required it.

## Downstream handoff

Phase 2 may rely on:

- the exact tour registry entry-point derivation;
- stable namespaced target and stop ids;
- zero-, one-, and two-beat support with stop-count progress;
- one active-tour run and route/focus restore contract;
- definition-owned prepare, ready, fallback, reconcile, and cleanup behavior;
- server routes that safely expose only operations a tour declares.

Phase 2 must not replace these with Library-specific state, a second Driver controller, a
second Settings or palette list, a second overlay, a second route guard, or a second target
registry.

## Cross-phase audit record

- Source requirements owned here: full engine extraction, two-beat support, namespaced
  targets, one active run, registry-derived entry points, one overlay, generalized skin,
  generalized See-work routes, and unchanged See-work behavior.
- The complete `MissionRoute` is the snapshot authority, resolving the source plan's obsolete
  extra selected-asset field.
- Phase 2 owns every Library-specific target, stop, run selection, fallback, and documentation
  change, so Phase 1 can merge and operate independently.
- Audit status: compatible with Phase 2 as written; no reverse dependency.
