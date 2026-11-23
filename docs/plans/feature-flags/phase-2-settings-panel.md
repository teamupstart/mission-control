# Feature flags - Phase 2: Settings panel

Read [`plan.md`](plan.md) for the approved goal and [`phased-plan.md`](phased-plan.md) for the
split. This file is the proposed route, not a specification: follow it where the repository
agrees, use judgement where it does not, and record any deviation in the pull request.

## 1. Outcome

An operator opens **Settings > Feature flags**, sees every preview feature in one searchable
list, switches any of them on or off, and can opt in to all of them, present and future, with
one master switch. Each click applies at once in every open window. Features that are on by
default sit under **Advanced**, where they can be switched off. The panel ships showing its
empty state, because no flag exists yet.

## 2. Entry criteria and dependencies

Phase 1 is merged to `main`. Read the merged `src/shared/feature-flag-registry.ts`,
`src/shared/feature-flags.ts`, `src/server/feature-flags/`, and `docs/feature-flags.md` before
starting, and use the names that are actually there.

## 3. Scope and non-goals

In scope: the Settings category, the list and its connected panel, the master switch's
question, shared leaves promoted from Trust, settings search and palette entries, one sentence
in Setup about alpha, operator documentation, the AGENTS.md rule, a fixture-registry build for
the browser suite, and two Playwright specs.

Not in scope:

- Any real flag. The shipped registry stays empty.
- Any change to the stored shape, the routes, the event, or the resolution rules.
- Any change to the conductor switch or its specs.
- A rail status dot for this category.
- Any hook in `src/` that exists for a test.

## 4. Repository findings and inherited contracts

Inherited from Phase 1 and not to be changed: the registry module's path and its two exports,
the config shape, the intent shapes, a flag intent always storing the choice, the
explicitly-switched-off list, `GET` and `PUT /api/feature-flags`, the `feature_flags` event,
`MissionState.featureFlags`, and the backup domain id `feature-flags`.

Findings:

- `SETTINGS_CATEGORIES` in `src/web/lib/settings-registry.ts` is grouped contiguously in
  `SETTINGS_GROUPS` order, and `test/settings-sidebar-render.test.ts` pins that, plus anchor
  uniqueness and anchor prefixes.
- `renderCategory` in `src/web/components/SettingsPage.tsx` is a `switch` over category ids.
  The same file builds the `ToggleBinding` map that lets a non-risky `toggle` control be
  flipped from a search result.
- `ALL_SETTINGS_CONTROLS` in `src/web/lib/settings-search.ts` holds every searchable control.
  `HARNESS_CONTROLS` shows how to derive entries from a registry. Each control declares its
  backup coverage with `backupDomains(...)`. The command palette reads the same controls
  through its settings provider in `src/web/lib/palette-index.ts`.
- `test/settings-backup-coverage.test.ts` requires each `settings`-surface domain to be named
  by a control. This phase moves `feature-flags` to that surface and adds the control together.
- Trust's reusable leaves live in `src/web/styles.css` around `.trust-pane-head`,
  `.trust-pane-title`, `.trust-pane-count`, `.trust-search`, and `.trust-grant` with its
  `is-on` and `is-off` states. `TrustPanel.tsx` is their only user.
- Modals use `Overlay` with the `.modal` shell. The inset belongs to the shell; children never
  re-declare it. A spec that opens a new modal calls `expectContentClearsBorder` from
  `e2e/fixtures/modal-inset.ts`.
- `UpdateSettingsPanel.tsx` owns the alpha control under Settings > Setup. Panels navigate
  with `SettingsNavigate` (category, optional anchor).
- **The browser suite already builds the app with modules swapped.**
  `e2e/fixtures/terminal-boundary-build.ts` bundles `src/server/index.ts` with esbuild and an
  `onResolve` plugin that points selected imports at fixtures, writing the bundle beside
  `dist/server/index.mjs`. `e2e/fixtures/daemon.ts` chooses that bundle when a spec asks for
  it through `extraEnv`, and passes `MISSION_WEB_DIR` to say which built dashboard the daemon
  serves. `e2e/global-setup.ts` and `e2e/fixtures/web-build.ts` already manage a snapshot of
  the built dashboard.
- Specs already refuse a request in the browser with Playwright's `route`, for example
  `e2e/specs/settings-worktrees.spec.ts` and `e2e/specs/residents-launch.spec.ts`.
- `.agents/memory/topbar-page-segment-guards.md` concerns title-bar page segments, not Settings
  categories. It is listed here so nobody goes looking: this phase adds no page segment.

## 5. Implementation steps

1. **Category.** Add `feature-flags` to `SETTINGS_CATEGORIES` directly after `setup`: label
   "Feature flags", group `sessions`, scope `machine`, a blurb, and keywords such as preview,
   experimental, beta, flag, opt in. Pick an icon no other category uses.
2. **Shared leaves.** Promote the Trust leaves the list needs (pane head, title, count, filter
   input, on/off pill and its states) to neutral `settings-` class names in
   `src/web/styles.css`, and update `TrustPanel.tsx` to use them. Do not fork the rules under
   a second name. Trust-only states (`is-trapped`, `is-armed`, the default-grant variant) stay
   Trust's. Trust must look and behave exactly as before.
3. **List** `src/web/components/FeatureFlagsView.tsx`. It renders from definitions, config, a
   per-flag pending or error state, and callbacks for "set flag" and "set master", so a static
   render test can pass definitions.
   - Header copy and the master switch. Its description says it turns on every preview
     feature and any a future update adds, and that updating to an alpha build does not turn
     it on, or any flag.
   - The preview list: pane head with title, count and filter; one row per `preview`
     definition with label, description, and an on/off pill that is a real button with an
     accessible name such as "Example feature: on". Each row carries
     `data-anchor="feature-flags/<id>"`. The master switch row carries
     `data-anchor="feature-flags/enable-all"`.
   - The filter matches label, description, keywords and id, across both lists. It is hidden
     when no definition exists at all.
   - Advanced: a collapsed disclosure listing `default-on` definitions, with a summary that
     counts the ones turned off. Absent when there are none. A filter that matches only
     Advanced rows opens it.
   - Empty states: no preview definitions ("No preview features right now. New ones appear
     here."), and a filter with no matches.
   - The master question. Turning the master on while Phase 1's explicitly-switched-off list
     is non-empty opens a dialog built on `Overlay` and the `.modal` shell. It names those
     flags and offers **Keep them off**, **Turn them on too**, and Cancel. Keep sends the
     master intent alone. Turn on sends it with `enableDisabled`. Cancel and Escape send
     nothing. With nothing switched off, the master applies immediately. Turning it off never
     asks. Because a flag intent always stores the choice, a flag switched off while the
     master was off is in that list and is asked about.
4. **Connected panel** `src/web/components/FeatureFlagsPanel.tsx`. Reads the config from
   mission state, takes its definitions from the registry module, and sends intents through
   the Phase 1 client. A click updates the control at once; a refusal rolls it back and shows
   an inline error on that row. The confirmed state always comes from the `feature_flags`
   event, so a second window and this one cannot disagree.
5. **Page wiring.** Add the `case` in `renderCategory`. Add `ToggleBinding`s for per-flag
   controls so they can be flipped from search.
6. **Search and palette.** In `settings-search.ts`, derive one `toggle` control per definition
   in the registry module (anchor `feature-flags/<id>`) and add one `jump` control for the
   master switch. All declare `backupDomains("feature-flags")`. Confirm the palette index
   picks them up through the existing settings provider, and update its test if it pins counts.
7. **Backup surface.** Change the `feature-flags` domain's `surface` from `runtime` to
   `settings` in `src/shared/settings-backup-domains.ts`, and remove Phase 1's comment about
   the move. The id does not change.
8. **Alpha sentence.** In `UpdateSettingsPanel.tsx`, under the alpha control, add one sentence
   saying alpha builds do not turn on preview features, with a link that navigates to the
   Feature flags category.
9. **Fixture-registry build** for the browser suite, entirely under `e2e/`.
   - `e2e/fixtures/feature-flag-registry.ts`: the same two exports as
     `src/shared/feature-flag-registry.ts`, holding at least two `preview` and two
     `default-on` definitions and an empty retired list.
   - `e2e/fixtures/feature-flags-build.ts`, modelled on `terminal-boundary-build.ts`: build
     the production daemon entry and the production dashboard with exactly one module, the
     registry module, resolved to that fixture. Everything else is the shipped code. Write the
     daemon bundle beside `dist/server/index.mjs` so runtime assets resolve, and the dashboard
     to its own directory. Build once per spec file and remove the outputs afterwards.
   - Teach `e2e/fixtures/daemon.ts` an opt-in for this build, the way it has one for the
     terminal boundary, and serve the fixture dashboard through `MISSION_WEB_DIR`.
   - Nothing in `src/` references the fixture, and no environment variable in the product
     adds flags. If building the dashboard this way proves impractical, the equivalent is
     acceptable only if it still runs the real connected panel, search and palette against a
     real daemon that knows the fixture flags; record the deviation in the pull request.
10. **Documentation.**
    - `docs/feature-flags.md`: add the operator's view of the panel, the master switch's
      behaviour and its question, and Advanced.
    - `docs/skills-and-settings.md`: the new category.
    - `docs/setup.md`: alpha does not enable preview features.
    - `docs/agent-guides/change-contracts.md`: note that the list leaves are shared between
      Trust and Feature flags.
    - `e2e/README.md`: the fixture-registry build and when a spec should use it.
    - `AGENTS.md`: a working rule that a new user-facing feature lands behind a feature flag,
      linking `docs/feature-flags.md`. `CLAUDE.md` is a symlink to it.

## 6. Data, API and compatibility

No new route, event, or stored field. The only data change is the backup domain's `surface`
metadata, which is not persisted. A snapshot written after Phase 1 restores unchanged.

## 7. Tests and verification

- `renderToStaticMarkup` tests for the list: empty state, a populated list, Advanced with a
  turned-off count, anchors present and unique.
- Updated pins: `test/settings-sidebar-render.test.ts`, `test/settings-backup-coverage.test.ts`,
  `test/palette-index.test.ts` where they enumerate categories, controls or domains.
- `e2e/specs/feature-flags.spec.ts`, against the shipped build with its empty registry: the
  category sits after Setup in the rail and opens; the empty state reads as specified; the
  master switch writes on click with no Save button, a second page follows without a reload,
  and the state survives a reload; settings search finds "Enable all feature flags" and lands
  on it; the alpha sentence in Setup navigates here.
- `e2e/specs/feature-flags-populated.spec.ts`, against the fixture-registry build, through the
  real connected panel and a real daemon:
  - the fixture flags are listed, preview in the main list and default-on under Advanced;
  - clicking a row's pill sends the intent to the daemon: the pill and its accessible name
    follow, a second page shows the change without a reload, and it survives a reload;
  - settings search finds a fixture flag by name and flips it from the result, and the panel
    in the other page follows;
  - the command palette lists the fixture flag and lands on its row;
  - the filter narrows the list and opens Advanced when only an Advanced row matches, and
    Advanced counts what is turned off;
  - the master switch applies without a dialog when nothing is switched off;
  - with the master off, switch a preview flag on and then off, then turn the master on: the
    dialog names that flag. Keep them off leaves it off with the master on. Turn them on too
    brings it on. Cancel changes nothing;
  - a refused write: intercept `PUT /api/feature-flags` with Playwright's `route` and answer
    with an error. The pill rolls back, the row shows its inline error, and no other page changes;
  - `expectContentClearsBorder` passes on the dialog.
- Trust regression: run Trust's existing specs and compare the panel by eye before and after
  the class promotion, in light and dark.
- Select by role, label or placeholder. No `data-testid`. No model tokens are spent.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.
- Visual check in a running fixture-registry build, both layouts and both themes: the panel
  with several flags, long descriptions wrapping, the dialog's inset, and the rail at its
  narrowest. Then the shipped build's empty panel.

## 8. Merge and exit criteria

- All commands above pass, and CI is green.
- Trust is visually unchanged.
- `FEATURE_FLAGS` is still empty in `src/`, no conductor file changed, and nothing in `src/`
  refers to a test fixture.
- The pull request attaches screenshots of the empty panel, the populated panel, Advanced
  open, and the dialog. Evidence is attached to the pull request, never committed.
- Documentation and AGENTS.md match what shipped.

## 9. Downstream handoff

The first flag's pull request may rely on: a row appearing in the panel as soon as an entry is
added to `FEATURE_FLAGS`, with search and palette entries derived automatically; the master
switch and Advanced needing no change; the fixture-registry build staying available for specs
that need more flags than the shipped registry holds; and `docs/feature-flags.md` describing
what that pull request owes, including a browser assertion against the shipped registry.

## 10. Cross-phase audit record

- Checked against Phase 1 after writing: this phase adds no stored field, route, or event. It
  consumes the apply-intent function and the explicitly-switched-off list as Phase 1 defines them.
- The backup domain's surface moves here by design; Phase 1 records the same handoff.
- Documentation is split so neither phase leaves a false statement: Phase 1 writes the
  developer model and lifecycle, this phase adds the operator's panel and the AGENTS.md rule
  once the mechanism is usable end to end.
- Plan Validation v3, repair round 1:
  - The first draft tested populated flags by mounting only the presentational list with local
    state. That could not observe an intent reaching the daemon, a second window updating,
    settings search, the palette, or a rollback. Step 9 and section 7 now run all of them
    through the connected panel against a fixture-registry build. The mounted-view fixture is
    gone.
  - The question relies on Phase 1 always storing a flag choice. Section 7 drives the exact
    sequence that the first draft would have missed.
  - The alpha copy in step 3 and step 8 follows the one rule in `plan.md`: the channel never
    changes a flag, and a single flag can be switched on by hand on any channel.
- Every requirement in `plan.md` has an owner in the table in `phased-plan.md`. No conflicts found.
