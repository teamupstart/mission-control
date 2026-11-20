# Task shaping - Phase 3: Settings panel

## Outcome

With the flag on, **Settings > Task shaping** lists the registered shapers in order and lets
the operator import a manifest, review exactly what it will run or call, enable, disable,
reorder, dry-run and remove a shaper, and set the caller identity and the two budgets. Every
change applies at once in every open window.

## Entry criteria and dependencies

- Phase 1 is merged. It can be built at the same time as phases 2, 5 and 6.

## Scope

- The `shaping_config` event, its snapshot field and the dashboard hook.
- The Settings category, gated live by the flag, with its search entries.
- The panel: list, import, enable, reorder, test, remove, caller identity, limits.
- A set or not set note on rows that name environment references, rendered from the reply's
  `references` field, which stays empty until Phase 5.
- Moving the `shaping` backup domain to the `settings` surface.

Not here: Found on disk rows (Phase 4), and the data behind the references note (Phase 5).

## Repository findings

- **Event.** `feature_flags` is the model: `Registry.emitFeatureFlags` drops identical frames,
  `src/server/index.ts` wires the change subscription once, `useEventStream.ts` has an
  exhaustive `case`, and the snapshot carries the config. Unlike the flags themselves, the
  shaping config sits behind its flag, so its snapshot field and event are gated. Decide
  `LINE_INPUT_EVENTS` membership explicitly: this event is not a line input.
- **Category.** `SETTINGS_CATEGORIES` in `src/web/lib/settings-registry.ts`, a `case` in
  `renderCategory` (`src/web/components/SettingsPage.tsx`), and entries in
  `ALL_SETTINGS_CONTROLS` (`src/web/lib/settings-search.ts`), each declaring a backup domain or
  a reason.
- **Live gate.** `VISIBLE_SETTINGS_CATEGORIES` is computed once at module load. The change
  contracts say a flag must feed one shared availability gate for all readers, updated live.
  Make availability a function of the resolved flags and give every reader that function.
- **Panel pattern.** `FeatureFlagsPanel.tsx` wraps a pure `FeatureFlagsView.tsx`, so static
  render tests can show populated rows. Controls write on click and roll back on a refused
  write.

## Steps

1. **Event.** `shaping_config` in `ServerEvent`, `Registry.emitShapingConfig`, the snapshot
   field `shaping`, the reducer case, and `useShapingConfig`. Wire
   `onShapingConfigChanged` once at daemon start and unsubscribe at shutdown. Both are gated
   like the routes: the snapshot carries `shaping` only while `task-shaping` is on, and no
   `shaping_config` frame is sent while it is off. The same wiring listens to
   `onFeatureFlagsChanged`: turning the flag on emits the current config, so an open window
   fills the panel with no reload, and turning it off emits `{ config: null }`, which the
   reducer clears.
2. **Category.** `task-shaping`, labelled "Task shaping", in the Sessions group, shown only
   while the flag is on, in the sidebar, search and the command palette alike.
3. **List.** One row per shaper in stored order, grouped by stage: label, id, transport, what
   it runs or calls, and its enable pill. Drag or buttons to reorder within a stage. An entry
   this build does not understand is marked unsupported, with its reason: it can be switched
   off or removed, but not switched on or edited. A row that names
   `{env:NAME}` references shows each as set or not set when the reply's `references` field
   has it, and never a value.
4. **Import.** A dialog that takes a manifest as pasted JSON or a file, validates it with
   `ShaperManifestSchema`, and shows before saving: the command and arguments or the URL, the
   environment variables it names, and the list of what a remote shaper is sent. Saving stores
   it disabled: the save is one `upsert`, which also stores off for its id, so a stored on
   left by a discovered shaper with the same id does not switch the import on.
5. **Test.** Pick a repository Mission Control knows, run `POST /api/shaping/test`, and show
   the outcome, the duration and the entries that would be injected.
6. **Caller identity and limits.** A text field for `caller.user`, and the step deadline and
   total budget within their maxima.
7. **Backup domain.** Change the `shaping` domain's surface to `settings` and name it from the
   panel's controls.
8. **Docs.** Fill "Settings" in `docs/task-shaping.md`. Add the category to
   `docs/skills-and-settings.md` and the event to `docs/event-stream.md`.

## Data, API and compatibility

- No route changes. The panel uses Phase 1's three routes and its intents.
- The backup domain id stays `shaping`. Only its surface changes, which no stored data reads.
- The event carries the whole bounded config. Pin its size in a test, as `feature_flags` does.

## Tests and verification

- `test/shaping-http.test.ts` gains the emitted event and the snapshot field: both absent
  while the flag is off with shapers stored, the config emitted when the flag turns on and
  cleared when it turns off, and an import over an id whose discovered shaper was switched
  on, which is saved off.
- `test/settings-sidebar-render.test.ts`, `test/settings-search.test.ts`,
  `test/palette-index.test.ts` and `test/settings-backup-coverage.test.ts` gain the category,
  its anchors and its domain, with the flag off and on.
- `renderToStaticMarkup` tests for the list: empty, populated, an unsupported entry, and a row with one set and one unset reference.
- `e2e/specs/task-shaping-settings.spec.ts`: the category appears when the flag is turned on
  in another window, and its list fills with the stored shapers without a reload; import a
  manifest and see what it will run, saved off; enable it; dry-run it against
  a repository; reorder; remove; set the identity and limits; search finds the category; a
  refused write rolls back; `expectContentClearsBorder` on the import dialog.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke` and
  `npm run test:e2e`.

## Merge and exit criteria

- Everything in the Outcome works in a browser with no reload.
- With the flag off the category is absent from the sidebar, search and the palette, and no
  snapshot or event carries the shaping config.
- An import is saved off, whatever was stored for its id before.
- No `data-testid`. Rows carry `data-anchor="task-shaping/<id>"`.

## Handoff

Phase 4 adds rows to this list and may rely on its row component accepting an origin and a
problem. Phase 5 fills the `references` field this panel already renders. Neither changes how
registered rows behave.

## Cross-phase audit

- Uses Phase 1's routes and schemas unchanged. Owns the Settings half of D4's registered path
  and D6's identity setting.
- Reconciled with Phase 4: the row takes `origin` and an optional `problem` from the start, so
  that phase adds data, not a second row type.
- Reconciled with Phase 5: the references note moved here, read from Phase 1's reply shape, so
  Phase 5 has no dashboard work and the two can merge in either order.
- Plan validation repair 3, 2026-11-19: the row for an entry this build does not understand
  now uses `plan.md`'s word, unsupported, and its rule: switch off or remove only.
- Review of the plan pull request, round 5, 2026-11-19: the snapshot field and the event
  were not gated, so a dashboard could receive the stored config while the flag was off.
  They now follow the flag, and an open window fills when it turns on. The import also
  saves off whatever its id had stored, through Phase 1's `upsert`.
