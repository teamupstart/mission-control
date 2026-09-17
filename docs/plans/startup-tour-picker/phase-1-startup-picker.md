# Phase 1: startup picker and walkthrough handoff

## Outcome and value

The phase delivers the approved list-and-preview tour picker on each new dashboard window or reload, with a saved opt-out. Every registered tour is available for inspection and explicit launch through its existing walkthrough. Settings and the command palette provide manual reopening.

References: [approved root plan](plan.md), [implementation index](phased-plan.md), and [selected B mockup](plan.html). The root plan's TP-01 through TP-10 and recorded human decisions define the approved outcome. This document describes a proposed implementation route; deviations may reflect verified repository changes or a better design and are reviewable in the implementation PR. It is planning reference material, not execution authorization. Repository working rules remain in [AGENTS.md](../../../AGENTS.md).

## Entry criteria and direct dependency

- This planning session's pull request has merged to `main`. All three plan paths and the mockup sources resolve in the checked-out default branch.
- The implementation baseline includes the current default branch with no unresolved conflicts. Existing repository policy covers checkout handling, required context, validation, and publication; this plan adds no operational policy.
- Direct dependency: the current planning session only. There are no prerequisite implementation task IDs and no other phases.
- Repository: `teamupstart/mission-control`, in the checkout attached to this task by Mission Control. No additional repository changes or attachments are needed.

## Scope and non-goals

This is one complete feature slice: catalog metadata, new startup preference, compatibility, modal UI, automatic and manual entry points, safe engine handoff, focus/stacking, responsive styling, focused tests, shared-fixture updates, full browser verification, and product documentation.

No tour editor, enable/disable catalog management, new tours, progress/resume/completion storage, account system, live synchronization to already-open windows, engine replacement, new server endpoints, SQLite table migration, worker behavior, native/Electron IPC, release configuration, or CI changes. Designs A and C remain illustrations in the planning record and are outside implementation scope.

## Repository findings and inherited contracts

| Existing owner | Contract to preserve |
| --- | --- |
| `src/web/tour/entries.ts` | One discovery entry per TourId feeds Settings and the command palette. Tour titles come from authored tours Markdown. The current order is See the work, Author what runs, Setup. Only the picker promotes the recommended Setup entry. |
| `src/web/tour/definitions.ts` | Exhaustive definitions already contain authored stops and per-tour cleanup descriptors. Counts derive from stops rather than flattened beats. |
| `src/web/App.tsx` | startTour accepts an ID and focus bookmark, preflights navigation, then commits the active-run ref synchronously. finishTour restores the route/snapshot, runs resource cleanup, and manages focus. |
| `src/web/workflows/useWorkflowRoute.ts` | A dirty route returns false and stores pendingRoute. Confirmation moves routes, not arbitrary continuations. Same-route navigation actually returns true despite an outdated interface comment. |
| `src/web/components/Overlay.tsx` | Registration is synchronous with mount and global shortcut guards consume the host. The primitive handles topmost Escape/backdrop dismissal; it is not a general focus trap. |
| `src/web/tour/focus-containment.ts` | Existing containment and bookmark conventions are available. Semantic replacement and late-frame focus safeguards remain intact. |
| `src/shared/protocol.ts`, `src/server/ui-config.ts`, `src/web/lib/uiConfig.ts`, `src/web/lib/uiCache.ts` | Daemon-owned UI config, schema defaults, legacy browser adoption, authoritative hydration, and optimistic per-field rollback. |
| `src/web/App.tsx`, `src/web/components/SetupBanner.tsx`, `src/web/components/SettingsRestoredBanner.tsx`, `src/web/styles.css` | App renders banners after the header and before AppPageShell, outside route content. The proposed preference-error notice uses `.app-banner`, `.app-banner-error`, copy/actions classes, and existing narrow-screen stacking. |
| `src/web/useNotifier.ts` | Private permission-gated desktop notifications for attention transitions, not a reusable in-app error API. App's timed launcher error flash is also launcher-specific. No generic dashboard-toast owner was found. |
| `src/web/lib/guided-tour.ts` | One-time consumption with a local retry marker. This is the superseded startup consumer, not a source for the new boolean's value. |
| `e2e/fixtures/test.ts` | Unrelated dashboard tests currently pin guidedTour off. The new default needs an explicit independent test-fixture override. |

No new server tour recipe or protocol action is required. Existing See the work may create temporary agent sessions after explicit tour launch and must still clean them up. Setup remains a read-only tour whose exit route is Trust.

## Proposed implementation sequence

### 1. Compatibility and startup eligibility

Focused coverage for the new default and startup state transitions precedes the automatic-launch change in the proposed sequence. `test/tour-picker-startup.test.ts` is the suggested helper-test location; final filenames may follow an existing convention.

The shared UI-config defaults and schema gain `showToursOnStartup: boolean`, default true. UiConfig and UiConfigPatch, API validation, storage, browser coercion, and cached values carry it through existing schema-derived paths. Runtime parsing, not only TypeScript typing, is part of the compatibility acceptance criteria.

Required compatibility cases:

- No persisted record: true.
- Existing record missing the field: true, even when guidedTour is false or absent.
- Explicit saved false: false after reads, writes to other fields, reload, and restart.
- Legacy localStorage import missing the field: true after adoption; an explicit supported false remains false.
- Cache says true while the daemon says false: no premature automatic picker before hydration.
- The old pending-guided-tour-consumption marker has no effect on new eligibility and causes no obsolete retry write.

The legacy serialized guidedTour field and parsing compatibility remain. Retirement of the obsolete browser consumer depends on an inventory showing no remaining live callers of useGuidedTour, consumeGuidedTour, the pending marker, and FIRST_RUN_TOUR. Only superseded behavior and its private tests are retired; startup regression coverage is replaced, while unrelated compatibility tests remain.

The new startup helper or App-owned state evaluates hydration, saved preference, catalog availability, prior handling, overlay state, and active-tour state. An offer becomes handled only at the defined lifecycle events. StrictMode effect replay, rerender, route changes, reconnect, and window focus must not reoffer it. A successful manual tour start before hydration settles the automatic offer. Open detection has no timer or browser polling.

### 2. Catalog projection

TourEntry gains the selected preview's summary and learning outcomes beside existing discovery metadata. Titles remain sourced from `tours/*.md` through the existing generation path. Direct-entry order is unchanged, and the picker recommendation has one definition in the registry.

An App/catalog adapter combines TOUR_ENTRIES with TOUR_DEFINITIONS by ID to derive stop counts. Settings and palette metadata remain free of runtime-definition imports. The adapter is small and browser-safe, with focused coverage proving registry membership and counts.

The picker promotes Setup without duplicating an explicit list of tour IDs. If the recommendation is absent, the first entry is selected; every entry still appears once. Decorative illustrations may be small inline SVG components with registry-owned presentation metadata and a generic fallback. They must not become a second catalog or contain live operator data.

### 3. B modal

The proposed TourPicker component lives under `src/web/components/`, has a unique ID in OVERLAY_IDS, and renders through Overlay under the existing OverlayHost.

The modal contains the approved two-column list and preview, native radio semantics, one explicit Start this tour action, close button, Dismiss, checkbox, loading/saving/error feedback, and empty state. Opening and selection have no navigation or dispatch side effects. Every registered tour has its actual title and derived stop count; previews make no duration, saved-progress, or completion promise.

The modal uses `.modal`, shell-owned horizontal inset, `.modal-bleed` for genuine edge-to-edge bands, current palette tokens, and desktop no-drag behavior. At narrow widths the list stacks over the preview and the footer wraps. Width and height are bounded by the viewport, with readable text and reachable controls; the implementation is laid-out UI rather than a scaled SVG image.

The selected tour radio receives initial focus. Tab is contained only while the picker is topmost; a higher leave-confirmation dialog owns focus. Escape and backdrop share the ordinary dismissal path. The origin bookmark is captured before opening and restored on ordinary dismissal, with a stable dashboard control for an automatic opening. Successful launch has a separate close reason so unmount does not steal the walkthrough's focus.

### 4. Automatic opening and durable opt-out

The approved picker gate replaces App's direct automatic Setup effect and waits for authoritative preference hydration and an idle overlay host. Opening or dismissing the modal preserves the current route, including deep links. The setup reminder banner remains independently owned.

Manual opening may show the catalog before hydration while disabling the preference checkbox with explanatory copy. Every actual picker opening consumes this document's automatic offer. A disabled preference settles that offer; re-enabling takes effect on the next new document.

App owns the checkbox's single in-flight flag and transient error across picker unmounts, and supplies them with an App-owned save callback to TourPicker. The callback clears any prior error, marks saving, awaits `updateUiConfig({ showToursOnStartup: next })`, and clears saving. That existing function calls `api.setUiConfig` through `PUT /api/ui/config` and returns false after per-field rollback on rejection. The boolean comes from `useUiConfig`, without a second local copy. Only the checkbox is disabled while pending, including after dismissal and manual reopening; start and dismissal remain available. New windows observe the daemon's stored preference; already-open windows do not need live sync.

#### Preference-save failure surface (TP-05)

On false, App retains **Could not save your tour preference. Your previous setting still applies.** for the life of the document until explicitly cleared. While the picker is open, the error appears once inline with `role="alert"`. After dismissal, it appears through the proposed `src/web/components/TourPreferenceNotice.tsx` after SetupBanner and before AppPageShell in App's existing banner region. This stateless renderer receives the message and actions from App, uses `.app-banner.app-banner-error`, `.app-banner-copy`, and `.app-banner-actions`, and places `role="alert"` on the message. It adds no notification context, queue, service, desktop-permission dependency, timer, or persistence mechanism.

The overlay/active-tour idle check used by this phase's startup gate also defers the notice while another overlay or walkthrough owns the screen; App retains the error until idle. Reporting never opens a modal, changes route, or moves focus. An inline failure survives subsequent picker dismissal and appears in the same notice. **Browse tours** calls the same guarded manual opener, hides the notice, and carries the error into the picker. **Dismiss** clears only the error, without writing config or changing the startup latch. The next explicit checkbox save clears the old error before trying again; a successful retry leaves no stale notice. There are no hidden retries or durable pending marker.

### 5. Existing launch lifecycle

The launch handler passes the selected TourId and pre-picker origin bookmark to startTour. Success closes the picker without restoring focus and renders the existing controller. Fast repeated starts must still produce one active run. A same-route start succeeds.

A false preflight result caused by a dirty route leaves the picker under the existing leave dialog. Stay preserves both the draft and selected preview. Leave performs the route transition; the picker remains and Start this tour is required again. There is no second stored route or automatic tour callback when pendingRoute clears.

Finish and exit preserve existing snapshot restoration, resource cleanup, Setup's Trust route/fallback, and any cleanup-failure retry UI. For an automatic-picker start without a restorable origin, other tours need a stable dashboard focus fallback. Restoration is bounded and yields when the user or a newer tour owns focus. The picker does not reopen automatically after a tour.

### 6. Manual discovery and retained direct shortcuts

Settings > Help & tours gains Browse tours, with a palette Do command opening the same picker. PaletteTarget, target identity/preview handling, and App's exhaustive activation switch follow the existing registry patterns. The real invoker is captured before palette teardown, as in the existing start-tour path.

Existing Start [tour name] controls keep calling startTour directly. They also settle the document's pending automatic offer when launch succeeds. Manual opening must not create a second picker over an active tour or another unresolved modal.

### 7. Test integration and product documentation

Shared E2E fixtures gain a startup-picker option, off for ordinary browser tests and on in dedicated startup cases. The fixture inventory includes all explicit UI-config seeds, including `e2e/specs/file-comment-typing.spec.ts` and dev-dashboard setup. Picker coverage replaces obsolete automatic-Setup and consumption assertions in `tour-engine.spec.ts`; engine tests remain, and the Help & tours count includes Browse tours.

The feature PR updates README, `docs/ui.md`, current comments, and tests to reflect startup behavior, upgrade default, saved checkbox, manual reopening, and lack of progress/resume. Historical plans remain a record of the earlier behavior.

## Data/API and compatibility contract

The only new persisted field is the default-true `showToursOnStartup` boolean in existing app_config.ui. No SQL schema migration is required for the JSON blob; existing field upgrade/default logic must still preserve explicit false. The daemon remains the only SQLite writer. UI config continues over existing GET/PUT routes, with no new SSE event or polling.

Tour IDs, entry routes, stop IDs, beats, and server recipes remain unchanged. Catalog copy is display metadata; active tour runtime stays in App and the shared controller. Legacy guidedTour remains accepted but is ignored by this client's new automatic-opening gate. Old one-time consumption does not represent an opt-out from the new feature.

## Validation reference

Focused unit coverage addresses eligibility, catalog projection, UI-config defaulting/legacy import/rollback, overlay registration, palette coverage, and snapshot/focus behavior independent of a browser. Suggested new files are `test/tour-picker-startup.test.ts` and `test/tour-picker.test.ts`; final filenames depend on component ownership. The following command examples identify the expected future implementation evidence, not actions authorized by this document.

```sh
node --test --import ./test/setup-state.mjs --import tsx test/tour-picker-startup.test.ts test/tour-picker.test.ts test/ui-config-store.test.ts test/ui-config-cache.test.ts test/ui-config-race.test.ts test/overlay-registry.test.ts test/setup-tour.test.ts test/tour-engine.test.ts
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/tour-picker.spec.ts e2e/specs/tour-engine.spec.ts e2e/specs/setup-banner-and-tour.spec.ts e2e/specs/library-tour.spec.ts e2e/specs/see-work-tour.spec.ts
npm run test:e2e
```

Environment, sandbox, repair, and publication policy remains in root AGENTS.md and the active task instructions. A full E2E result after focused verification is part of initial feature acceptance because automatic startup and shared seeds affect unrelated specs. This reference adds no separate command-execution or push policy.

Expected coverage in `e2e/specs/tour-picker.spec.ts`, alongside the existing tour specs, maps to TP-01 through TP-10:

- Fresh, upgraded, explicitly opted-out, and re-enabled profiles; reload, a new window, no reopen on route/focus/rerender/reconnect; delayed hydration and failed hydration without a default flash.
- All registered tours and matching count/preview; select-only has no side effects; Start reaches each actual first stop; fast repeated activation and same-route launch.
- Dismiss, close, Escape, backdrop, route preservation, manual reopen from Settings and palette, and retained direct tour entries.
- Pending preference save, success across reload and another window, rollback on rejection with open picker and after dismissal, and old pending marker ignored.
- Dirty draft Stay, Leave, then Start again; other overlay deferral and no picker over an active walkthrough.
- Keyboard radio selection, topmost-only focus trap, primary action, restoration on dismissal and tour exit, Setup on Trust, and no late focus theft.
- Light/dark, reduced motion, 390 by 844 and 1024 by 600 layouts, zoom, reachable controls, and `expectContentClearsBorder` for the dialog.
- Fake agents in all walkthrough launches; opening, browsing, and dismissing produce zero new tour tasks; See the work's actual launch still cleans up its temporary sessions.

Required post-dismissal rejection scenario in `e2e/specs/tour-picker.spec.ts`:

1. Initial conditions: startup display is true, desktop notifications are off, and only the `PUT /api/ui/config` request containing showToursOnStartup is held by the fixture.
2. After the user unchecks the checkbox, Saving is visible and the checkbox is disabled. The user dismisses the picker while the request is pending and navigates to Library; the focused navigation control becomes the focus baseline.
3. When the held request receives HTTP 503, exactly one visible App-banner alert contains the specified error copy. The picker remains closed, the Library route is unchanged, and focus remains on the baseline control. The daemon's GET config still reports true because the intercepted write never reached it.
4. After the user selects the banner's Browse tours action, the restored checkbox is checked, the error is inline, and no duplicate banner is visible. A retry with the next PUT allowed through clears the error on success, makes GET report false, and suppresses the startup picker after reload.
5. Related independent cases: failure while open followed by dismissal; reopen while still pending keeps the checkbox disabled; notice Dismiss clears only the error and leaves the saved value true; a failure after starting a tour waits until tour exit; an intervening overlay likewise defers the notice. Banner actions remain reachable at the narrow viewport.

Runtime screenshots and exact focused command results are the expected implementation evidence; this plan's mockups illustrate only the agreed design. Evidence storage and registration follow the existing repository and task policy. Evidence files and report.html are not planning deliverables.

## Merge and exit criteria

All ten root requirements and both design decisions are satisfied. Focused tests, typecheck, lint, build, smoke, and browser checks pass; user-facing documentation matches; the new automatic gate is the sole one in the current client; existing walkthrough cleanup and Setup landing regressions remain covered. The PR contains only this feature and its tests/docs, has current evidence, resolves merge conflicts, and reaches green CI with no unresolved actionable review comments. Review and merge authorization remain governed by repository and task policy.

This phase is done when its one Mission Control implementation PR merges. Known gaps in these criteria are part of this phase, not a later cleanup phase.

## Downstream handoff

There are no later phases. Future tour registrations can rely on automatic catalog inclusion and definition-derived counts. Future startup preferences must preserve explicit false and the one-offer-per-document boundary. Future overlays must retain single-owner keyboard handling, and future tour changes must preserve start preflight, resource cleanup, and declared exit destinations. Any future editor or progress/resume feature requires a separate product decision.

## Cross-phase audit record

2026-09-15: compared this phase with the complete approved root plan and phased index. TP-01 through TP-10 are all owned here exactly once. B, every-open with opt-out, and the new/existing-profile default are preserved. The one-time guidedTour field is explicitly distinguished from the new setting; no conflicting startup consumer remains. The actual same-route return value, route-only confirmation, overlay focus limitations, and E2E suppression seeds are accounted for. No multi-repository dependency, schema ordering hazard, parallel merge contention, or undocumented later work remains. No approved behavior changed during decomposition.

Review repair on 2026-09-15: removed the operator-specific local checkout path from the guide. The repository identity and all task-relative plan paths remain unchanged; no behavior, dependency, or acceptance criterion was revised.

Plan Validation v1 repair, run `5a07bf04-605f-4442-82f0-2b1af91a7035`, round 1: replaced the unverified dashboard-toast assumption with a minimal App-owned notice in the verified banner region. This explicitly supersedes the earlier failure-surface wording in the root and phase. App owns request/error lifetime; the existing store owns rollback; this phase owns the renderer and the held-request browser scenario. TP-05 and all recorded human choices, including Dismiss, remain intact. No implementation or additional phase was introduced.

Inspector review amendment on 2026-09-15: agent-directed reading, editing, testing, and publication wording is replaced by declarative design and validation references. Existing repository instructions retain operational policy. TP-01 through TP-10, submitted choices, the preference-failure contract, and the single scheduled task are unchanged.
