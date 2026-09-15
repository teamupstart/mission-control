# Phase 1: startup picker and walkthrough handoff

## Outcome and value

Give Mission Control the approved list-and-preview tour picker on each new dashboard window or reload, with a saved opt-out. Show every registered tour, let the person inspect one and explicitly start its existing walkthrough, and make the picker available again through Settings and the command palette.

Read [the approved root plan](plan.md), [the implementation index](phased-plan.md), and [the selected B mockup in the rendered plan](plan.html). The root plan's TP-01 through TP-10 and recorded human decisions are the fixed outcome. This phase document is the proposed implementation route: adapt to verified repository changes or a better implementation and explain deviations in the PR without silently changing the approved behavior.

## Entry criteria and direct dependency

- This planning session's pull request has merged to `main`. All three plan paths and the mockup sources resolve in the checked-out default branch.
- Rebase or merge the current default branch according to repository rules before implementation; preserve unrelated work and resolve conflicts. Read root AGENTS.md, its memory index, architecture, change contracts, and e2e/README.md.
- Direct dependency: the current planning session only. There are no prerequisite implementation task IDs and no other phases.
- Repository: `teamupstart/mission-control`, use the repository checkout attached to this task by Mission Control. No additional repository changes or attachments are needed.

## Scope and non-goals

This is one complete feature slice: catalog metadata, new startup preference, compatibility, modal UI, automatic and manual entry points, safe engine handoff, focus/stacking, responsive styling, focused tests, shared-fixture updates, full browser verification, and product documentation.

No tour editor, enable/disable catalog management, new tours, progress/resume/completion storage, account system, live synchronization to already-open windows, engine replacement, new server endpoints, SQLite table migration, worker behavior, native/Electron IPC, release configuration, or CI changes. Do not implement designs A or C. Keep their illustrations as the planning record.

## Repository findings and inherited contracts

| Existing owner | Contract to preserve |
| --- | --- |
| `src/web/tour/entries.ts` | One discovery entry per TourId feeds Settings and the command palette. Tour titles come from authored tours Markdown. The current order is See the work, Author what runs, Setup. Only the picker promotes the recommended Setup entry. |
| `src/web/tour/definitions.ts` | Exhaustive definitions already contain authored stops and per-tour cleanup descriptors. Derive counts from stops, not flattened beats. |
| `src/web/App.tsx` | startTour accepts an ID and focus bookmark, preflights navigation, then commits the active-run ref synchronously. finishTour restores the route/snapshot, runs resource cleanup, and manages focus. |
| `src/web/workflows/useWorkflowRoute.ts` | A dirty route returns false and stores pendingRoute. Confirmation moves routes, not arbitrary continuations. Same-route navigation actually returns true despite an outdated interface comment. |
| `src/web/components/Overlay.tsx` | Registration is synchronous with mount and global shortcut guards consume the host. The primitive handles topmost Escape/backdrop dismissal; it is not a general focus trap. |
| `src/web/tour/focus-containment.ts` | Existing containment and bookmark conventions are available. Preserve semantic replacement and late-frame focus safeguards. |
| `src/shared/protocol.ts`, `src/server/ui-config.ts`, `src/web/lib/uiConfig.ts`, `src/web/lib/uiCache.ts` | Daemon-owned UI config, schema defaults, legacy browser adoption, authoritative hydration, and optimistic per-field rollback. |
| `src/web/lib/guided-tour.ts` | One-time consumption with a local retry marker. This is the superseded startup consumer, not a source for the new boolean's value. |
| `e2e/fixtures/test.ts` | Unrelated dashboard tests currently pin guidedTour off. The new default needs an explicit independent test-fixture override. |

No new server tour recipe or protocol action is required. Existing See the work may create temporary agent sessions after explicit tour launch and must still clean them up. Setup remains a read-only tour whose exit route is Trust.

## Implementation steps

### 1. Pin compatibility and startup eligibility

Add focused tests for the new default and startup state transitions before changing the automatic launch effect. Suggested helper coverage belongs in `test/tour-picker-startup.test.ts`; file names may follow a better existing convention.

Add `showToursOnStartup: boolean` with default true to the shared UI-config defaults and schema. Verify that UiConfig and UiConfigPatch, API validation, storage, browser coercion, and cached values carry it through the existing schema-derived paths. Do not assume a TypeScript type declaration alone changes runtime parsing.

Required compatibility cases:

- No persisted record: true.
- Existing record missing the field: true, even when guidedTour is false or absent.
- Explicit saved false: false after reads, writes to other fields, reload, and restart.
- Legacy localStorage import missing the field: true after adoption; an explicit supported false remains false.
- Cache says true while the daemon says false: no premature automatic picker before hydration.
- The old pending-guided-tour-consumption marker has no effect on new eligibility and causes no obsolete retry write.

Keep the legacy serialized guidedTour field and its parsing compatibility. Search all callers of useGuidedTour, consumeGuidedTour, the pending marker, and FIRST_RUN_TOUR before retiring the unused browser consumer. Remove only behavior rendered obsolete by this feature and replace its first-run regression coverage. Leave unrelated compatibility tests intact.

The new startup helper or App-owned state evaluates hydration, saved preference, catalog availability, prior handling, overlay state, and active-tour state. Mark an offer handled only at the defined lifecycle events. StrictMode effect replay, rerender, route changes, reconnect, and window focus must not reoffer it. A successful manual tour start before hydration settles the automatic offer. Do not add timers or browser polling to detect opens.

### 2. Prepare one catalog projection

Extend TourEntry with the selected preview's summary and learning outcomes, authored beside existing discovery metadata. Preserve title sourcing in `tours/*.md`; do not hand-edit generated content. Keep the existing direct-entry order unchanged and define the picker recommendation once in that registry.

At the App/catalog adapter boundary, combine TOUR_ENTRIES with TOUR_DEFINITIONS by ID to derive stop counts. Do not import the runtime definitions into Settings or the palette just to render catalog metadata. Keep any adapter small and browser-safe, with one test proving registry coverage and counts.

Promote Setup for picker display without duplicating an explicit list of tour IDs. If the recommended entry is absent, use the first entry; every entry still appears once. Decorative illustrations may be small inline SVG components with registry-owned presentation metadata and a generic fallback. They must not become a second catalog or contain live operator data.

### 3. Build the B modal

Add the focused TourPicker component under `src/web/components/` and register a unique ID in OVERLAY_IDS. Render through Overlay under the existing OverlayHost.

Implement the approved two-column list and preview, native radio semantics, one explicit Start this tour action, close button, Not now, checkbox, loading/saving/error feedback, and empty state. Opening and selection have no navigation or dispatch side effects. Use actual current titles and derived stop counts. Preview all registered tours without promising duration, saved progress, or completion.

Use `.modal`, shell-owned horizontal inset, `.modal-bleed` for genuine edge-to-edge bands, current palette tokens, and desktop no-drag behavior. At narrow widths, stack the list over the preview and wrap the footer. Bound width and height against the viewport, with reachable close and action controls. Preserve readable text rather than scaling the SVG design image.

On open, focus the selected tour radio. Trap Tab within the picker only while it is topmost; allow the higher leave-confirmation dialog to own focus. Escape and backdrop call the same ordinary dismissal path. Capture the original invoker before opening and restore it, or a stable dashboard control for automatic opening, on ordinary dismissal. Successful launch uses a separate close reason so unmount does not steal the walkthrough's focus.

### 4. Wire automatic opening and the durable opt-out

Replace App's direct automatic Setup effect with the approved picker gate. Wait for authoritative preference hydration and an idle overlay host. Opening or dismissing the modal preserves the current route, including deep links. The setup reminder banner remains independently owned.

Manual opening may show the catalog before hydration while disabling the preference checkbox with explanatory copy. Every actual picker opening consumes this document's automatic offer. A disabled preference settles that offer; re-enabling takes effect on the next new document.

Use updateUiConfig for checkbox writes. Disable only the checkbox while a single save is pending; preserve start and dismissal. On rejection, roll back to the accepted value and show an inline error if still open or a dashboard toast if closed. Do not add a local durable pending marker or hidden retry loop. New windows observe the daemon's stored preference; already-open windows do not need live sync.

### 5. Reuse the existing launch lifecycle

Pass the selected TourId and the pre-picker origin bookmark to startTour. On success, close the picker without restoring focus and let the existing controller render. Fast repeated starts must still produce one active run. A same-route start succeeds.

On a false preflight result caused by a dirty route, keep the picker under the existing leave dialog. Stay preserves both the draft and selected preview. Leave performs the route transition; the picker remains and Start this tour is required again. Do not store a second route or invoke a tour callback automatically when pendingRoute clears.

On finish or exit, preserve existing snapshot restoration, resource cleanup, Setup's Trust route/fallback, and any cleanup-failure retry UI. For an automatic-picker start without a restorable origin, other tours need a stable dashboard focus fallback. Keep restoration bounded and give up when the user or a newer tour owns focus. The picker does not reopen automatically after a tour.

### 6. Add manual discovery without replacing direct shortcuts

Add Browse tours to Settings > Help & tours. Add a palette Do command that opens the same picker. Extend PaletteTarget, target identity/preview handling, and App's exhaustive activation switch through the existing registry patterns. Capture the real invoker before palette teardown, following the existing start-tour path.

Existing Start [tour name] controls keep calling startTour directly. They also settle the document's pending automatic offer when launch succeeds. Manual opening must not create a second picker over an active tour or another unresolved modal.

### 7. Integrate tests, document, and validate

Introduce a startup-picker option in shared E2E fixtures, off for ordinary browser tests and on in dedicated startup cases. Audit all explicit UI-config seeds, including `e2e/specs/file-comment-typing.spec.ts` and dev-dashboard setup. Replace the obsolete automatic-Setup and consumption tests in `tour-engine.spec.ts`; retain its engine tests and update the Help & tours group count for Browse tours.

Update README and `docs/ui.md` in the feature PR to describe the startup picker, upgrade default, saved checkbox, manual reopening, and lack of progress/resume. Update stale comments and tests describing direct automatic Setup. Do not edit old historical plans to pretend the earlier behavior never existed.

## Data/API and compatibility contract

The only new persisted field is the default-true `showToursOnStartup` boolean in existing app_config.ui. No SQL schema migration is required for the JSON blob; existing field upgrade/default logic must still preserve explicit false. The daemon remains the only SQLite writer. UI config continues over existing GET/PUT routes, with no new SSE event or polling.

Tour IDs, entry routes, stop IDs, beats, and server recipes remain unchanged. Catalog copy is display metadata; active tour runtime stays in App and the shared controller. Legacy guidedTour remains accepted but is ignored by this client's new automatic-opening gate. No phase is allowed to interpret old one-time consumption as an opt-out from the new feature.

## Tests and verification commands

Add or adapt focused unit cases for eligibility, catalog projection, UI-config defaulting/legacy import/rollback, overlay registration, palette coverage, and snapshot/focus behavior that can be tested without a browser. Suggested new files are `test/tour-picker-startup.test.ts` and `test/tour-picker.test.ts`; adjust command paths if the final ownership differs.

```sh
node --test --import ./test/setup-state.mjs --import tsx test/tour-picker-startup.test.ts test/tour-picker.test.ts test/ui-config-store.test.ts test/ui-config-cache.test.ts test/ui-config-race.test.ts test/overlay-registry.test.ts test/setup-tour.test.ts test/tour-engine.test.ts
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/tour-picker.spec.ts e2e/specs/tour-engine.spec.ts e2e/specs/setup-banner-and-tour.spec.ts e2e/specs/library-tour.spec.ts e2e/specs/see-work-tour.spec.ts
npm run test:e2e
```

Use the root AGENTS.md environment and sandbox rules for these commands. The full E2E run is appropriate once after focused verification because automatic startup and shared seeds affect unrelated specs. Repair rounds run targeted tests for the failure, then push; do not rerun the full suite before every repair commit.

The new `e2e/specs/tour-picker.spec.ts` must prove TP-01 through TP-10 alongside the existing tour specs:

- Fresh, upgraded, explicitly opted-out, and re-enabled profiles; reload, a new window, no reopen on route/focus/rerender/reconnect; delayed hydration and failed hydration without a default flash.
- All registered tours and matching count/preview; select-only has no side effects; Start reaches each actual first stop; fast repeated activation and same-route launch.
- Not now, close, Escape, backdrop, route preservation, manual reopen from Settings and palette, and retained direct tour entries.
- Pending preference save, success across reload and another window, rollback on rejection with open picker and after dismissal, and old pending marker ignored.
- Dirty draft Stay, Leave, then Start again; other overlay deferral and no picker over an active walkthrough.
- Keyboard radio selection, topmost-only focus trap, primary action, restoration on dismissal and tour exit, Setup on Trust, and no late focus theft.
- Light/dark, reduced motion, 390 by 844 and 1024 by 600 layouts, zoom, reachable controls, and `expectContentClearsBorder` for the dialog.
- Fake agents in all walkthrough launches; opening, browsing, and dismissing produce zero new tour tasks; See the work's actual launch still cleans up its temporary sessions.

Capture final rendered runtime screenshots in a gitignored directory and register them with exact focused command results. These prove the implementation, whereas this plan's mockups prove only the agreed design. Do not commit evidence files or report.html artifacts.

## Merge and exit criteria

All ten root requirements and both design decisions are satisfied. Focused tests, typecheck, lint, build, smoke, and browser checks pass; user-facing documentation matches; the new automatic gate is the sole one in the current client; existing walkthrough cleanup and Setup landing regressions remain covered. The PR contains only this feature and its tests/docs, has current evidence, resolves merge conflicts, and reaches green CI with no unresolved actionable review comments. Follow the repository's review/merge authorization rules.

This phase is done when its one Mission Control implementation PR merges. Do not create a follow-on cleanup phase to repair a known gap in these criteria.

## Downstream handoff

There are no later phases. Future tour registrations can rely on automatic catalog inclusion and definition-derived counts. Future startup preferences must preserve explicit false and the one-offer-per-document boundary. Future overlays must retain single-owner keyboard handling, and future tour changes must preserve start preflight, resource cleanup, and declared exit destinations. Any future editor or progress/resume feature requires a separate product decision.

## Cross-phase audit record

2026-09-15: compared this phase with the complete approved root plan and phased index. TP-01 through TP-10 are all owned here exactly once. B, every-open with opt-out, and the new/existing-profile default are preserved. The one-time guidedTour field is explicitly distinguished from the new setting; no conflicting startup consumer remains. The actual same-route return value, route-only confirmation, overlay focus limitations, and E2E suppression seeds are accounted for. No multi-repository dependency, schema ordering hazard, parallel merge contention, or undocumented later work remains. No approved behavior changed during decomposition.

Review repair on 2026-09-15: removed the operator-specific local checkout path from the guide. The repository identity and all task-relative plan paths remain unchanged; no behavior, dependency, or acceptance criterion was revised.
