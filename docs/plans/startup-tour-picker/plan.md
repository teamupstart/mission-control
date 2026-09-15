# Startup tour picker

Status: approved by the operator on 2026-09-15. Scope: planning documents and mockups only. No application behavior is implemented by this task. This is product and design reference material, not execution authorization; repository working rules remain in [AGENTS.md](../../../AGENTS.md).

## Outcome

When a person opens Mission Control, a dismissible modal presents every registered tour. They can inspect a tour, explicitly start it, and walk through it with the existing guided-tour engine.

## Recorded human decisions

| Decision | Submitted selection | Consequence |
| --- | --- | --- |
| Layout | **B. List and preview** | The tour catalog appears beside the selected tour's description, learning outcomes, illustration, and Start this tour button. |
| Startup | **Every open, with an opt-out** | The picker appears once per new dashboard document, including a new window or reload, for both new and existing profiles, with a saved opt-out. Refocusing an existing window never retriggers it. |

The first two selections were returned by Mission Control's structured request_input tool. Final approval and the implementation follow-up were returned by request_plan_decisions: **Approve this plan** and **Create phased implementation plan**. Alternatives A and C below are retained as the requested design record; they are not implementation alternatives still awaiting a choice.

## Scope and product requirements

Configured tours means the tours registered in the current build's `TOUR_ENTRIES`: **See the work**, **Author what runs**, and **Set up this machine** today. Future registrations appear automatically through the same catalog. This feature does not add a tour editor, per-tour enable/disable settings, new tours, progress tracking, completion badges, or resume behavior.

| ID | Requirement and observable acceptance |
| --- | --- |
| TP-01 | After authoritative UI preference hydration, a new dashboard document opens the picker once when startup display is enabled. Reload and a second window qualify; route changes, SSE reconnects, rerenders, and returning focus do not. |
| TP-02 | The picker lists every registered tour exactly once. Setup is recommended and initially previewed; the remaining entries retain registry order. Selecting a row changes only the preview. |
| TP-03 | Start this tour invokes the existing start path for the selected ID. Opening, browsing, and dismissing the picker create no tasks or tours. A successful start replaces the picker with exactly one walkthrough at its first stop. |
| TP-04 | Dismiss, the close button, Escape, and clicking the backdrop dismiss the picker without changing the underlying route or saved startup preference. It stays closed for that document. |
| TP-05 | Show tours when Mission Control opens defaults on for new and existing profiles. An accepted change persists through reload, daemon restart, and another window using the same state home. Failed saves are reported and do not falsely appear saved. |
| TP-06 | Browse tours in Settings > Help & tours and the command palette reopens the picker regardless of the startup preference. Existing per-tour launch controls still work. |
| TP-07 | The picker participates in the overlay registry, traps focus while topmost, restores an appropriate focus target on dismissal, and never competes with another walkthrough or a higher-priority dialog. Keyboard users can select and start every tour. |
| TP-08 | Dirty-route preflight, tour target readiness, existing resource cleanup, snapshot restoration, and Setup's Trust landing remain intact. A refused preflight starts nothing. |
| TP-09 | The selected layout works in light/dark themes, reduced motion, and narrow/short windows. The dialog content clears its border and its controls remain reachable without horizontal page scrolling. |
| TP-10 | Browser coverage uses fake agents and proves catalog selection reaches each actual walkthrough. Documentation states the new startup behavior and reusable entry points. |

## Mockups and selected direction

These are design illustrations using Mission Control's dark palette and the actual tour names. The background contains illustrative placeholder work, not operator data. The startup checkbox is a proposed preference that is enabled by default and saved per Mission Control state home. Stop counts describe current authored tours, not saved progress. No time estimates, completion badges, or resume behavior are promised.

### A. Card gallery

![A: Card gallery with three tours and a Start tour button on each card](mockup-a.svg)

Three equal cards show all tours, each with a small product illustration, summary, stop count, and direct Start tour button. Setup is the suggested first choice; nothing starts without a click.

- Best for: visual discovery and a small catalog.
- Tradeoff: occupies more space; a growing catalog requires scrolling.
- Estimated implementation effort: medium, roughly 300 to 500 non-test lines including launch integration, preference handling, and styling.

### B. List and preview (selected)

![B: Tour list on the left and a preview with learning outcomes and Start this tour on the right](mockup-b.svg)

A list keeps every tour available while the preview explains the selected tour. Setup is initially previewed. Selecting another row only changes the preview; Start this tour begins the walkthrough. The illustration and learning outcomes change with the selection.

- Best for: helping a new user decide which tour answers their question.
- Tradeoff: starting a tour other than the initially previewed tour takes two actions. The preview stacks below the list on narrow screens.
- Estimated implementation effort: medium, roughly 400 to 650 non-test lines including launch integration, preference handling, and styling.

### C. Quick-start menu

![C: Compact modal with three directly launchable tour rows](mockup-c.svg)

A compact list presents the title, short description, and stop count. Activating a row starts its tour immediately. All three current tours fit in a small modal.

- Best for: repeat visits and quick selection with minimal reading.
- Tradeoff: less explanation before starting; the entire row is the launch control.
- Estimated implementation effort: small to medium, roughly 250 to 450 non-test lines including launch integration, preference handling, and styling.

## Interaction details

### Opening and discovery

- The automatic picker opens only after `useUiConfigHydrated()` reports the daemon-backed preference. Cached defaults alone must never flash the modal before a saved false value arrives. Hydration failure leaves the dashboard usable and follows the existing bounded-backoff hydration retry behavior.
- A per-document handled latch prevents repeat automatic openings. It is marked when the picker is actually shown, manually opened, or a tour successfully starts through any entry point. A disabled preference settles startup for this document; enabling it later takes effect on the next document, without reopening over current work.
- If another overlay or a tour owns the screen when startup becomes eligible, the picker waits for the overlay host to become idle. A tour that already started cancels the pending automatic offer. The picker never stacks over an active tour or confirmation.
- Deep links remain deep links: opening or dismissing the picker does not navigate. It may appear over any dashboard route. Returning to a minimized Electron window does not constitute a new open. A renderer reload does.
- Manual opening works before preference hydration: the catalog is available, while the checkbox is disabled with a loading explanation until its saved value is known. Opening manually consumes the document's automatic offer.
- Browse tours appears in the existing Settings Help & tours group and as a matching palette command. The three existing direct tour shortcuts remain. No new topbar segment, route, or keyboard shortcut is required.

### Selection and tour handoff

- Tour selection uses a labeled list of native radio controls styled as rows. A selected row has both a visible selection marker and an accessible checked state. Arrow keys select within the list; Tab reaches the preview's primary action.
- The preview contains the authored tour title, a concise summary, three learning outcomes, a decorative product illustration, the number of authored stops, and Start this tour. Counts come from the registered definition's stops, never a hand-kept numeric list or flattened spotlight beats.
- Setup is the initial selection and appears first without mutating the shared registry's existing discovery order. The recommendation is declared once beside the registry. If absent in a future catalog, the first entry is selected. Reopening starts at this default, with no remembered selection requirement.
- The launch handler calls the existing `startTour(selectedId, originBookmark)` preflight. Only a true result closes the picker as a successful handoff. The active-run ref already prevents fast repeated starts; there is no second controller or queued second tour.
- If navigation is held by a dirty draft, the picker remains mounted beneath the existing leave dialog. Stay returns to the picker with the draft intact. Leave performs the existing route transition and returns to the selected preview; the user presses Start this tour again. There is no hidden deferred tour callback. This deliberately preserves the router's current contract.
- Successful launch unmounts the picker without running its ordinary dismissal refocus. The walkthrough owns focus. The tour receives the bookmark captured before the picker opened, not a now-removed row or Start button.
- Ordinary picker dismissal restores the manual invoker, or a stable dashboard control such as Settings for an automatic opening. Tour exit preserves the existing bookmark restoration and declared exit route. Setup's absent-invoker fallback remains its Trust rail row. Other tours launched from the automatic picker use a stable dashboard fallback if the original bookmark cannot be restored. A late focus callback must not steal focus once the operator has moved elsewhere.
- Completing or exiting a tour returns to its existing destination, without automatically reopening the picker. Browse tours is available for another tour. The existing See the work demo-session lifecycle and cleanup remain the engine's responsibility.

### Preference and compatibility

- The existing `UI_CONFIG_DEFAULTS` and Zod UI-config contract gain `showToursOnStartup: boolean`, defaulting to true. It is stored through the existing `/api/ui/config` patch flow into daemon-owned `app_config.ui`; no new table, endpoint, IPC channel, or polling is needed.
- An existing record or legacy browser import without this field receives true. Explicit false is preserved. The old `guidedTour: false` value records consumption of a different one-time behavior and must not disable this new feature on upgrade.
- The picker gate replaces App's automatic `FIRST_RUN_TOUR` launch. The old serialized `guidedTour` field and compatibility parsing remain, but no longer start tours in this client. The old local pending-consumption marker must neither hide the picker nor trigger writes from the retired consumer. Retirement of the unused hook/consumer and private tests depends on confirmed absence of remaining callers; the new startup contract replaces the relevant regression coverage.
- The Setup recommendation belongs to a clearly named catalog recommendation constant; the misleading first-run-launch name is retired if it has no remaining live consumers. Persisted tour IDs and authored steps remain unchanged.
- Checkbox changes save immediately through `updateUiConfig`, one at a time. While saving, the checkbox is disabled and displays Saving. Dismissal and tour start remain available.
- App owns the checkbox's in-flight flag and transient save error, so dismissal or route changes cannot discard a pending result. The callback path is TourPicker to App's save handler to `updateUiConfig({ showToursOnStartup: next })` to `api.setUiConfig` (`PUT /api/ui/config`). A false result follows the existing per-field optimistic rollback. The restored value comes from `useUiConfig`, without a second preference copy. Reopening during a save keeps the checkbox disabled.
- Failure displays **Could not save your tour preference. Your previous setting still applies.** once inline with `role="alert"` while the picker is open. After dismissal, App retains it and renders the proposed `TourPreferenceNotice` in its existing banner area, after SetupBanner and before AppPageShell. If another overlay or tour owns the screen, the notice waits until idle. A failure shown inline also survives subsequent dismissal. Error reporting never reopens the picker, changes the route, or moves focus.
- The notice is a small feature-owned renderer using `.app-banner.app-banner-error`, `.app-banner-copy`, and `.app-banner-actions`; its message has `role="alert"`. **Browse tours** uses the same guarded picker opener and transfers the error inline; **Dismiss** clears only the transient error. The error remains until dismissal or the next explicit save attempt, without a timeout. Changing the checkbox again retries the save. No generic toast service, desktop notification, hidden retry, or additional persistence store is needed.
- Saved preferences are scoped to the Mission Control daemon's state home, not an authenticated account. New documents read the current saved value. Live synchronization to an already-open second window remains outside scope, consistent with the current UI-config store.

### Layout and accessibility

- The picker uses the existing `Overlay` and a new registered tour-picker ID, with an accessible dialog name of Explore Mission Control. The current primitive owns stacking and dismissal, but does not supply general focus trapping; the new dialog must own that behavior using existing focus-containment conventions.
- The picker uses `.modal` and its shell-owned inset. `.modal-bleed` is limited to the divided list/preview region and footer bands that reach the edge. Child elements do not duplicate the horizontal inset.
- Desktop: approximately 880px dialog width, a 300px tour list, flexible preview, and a footer containing the checkbox and Dismiss. Viewport-relative max-width/max-height and scrollable content keep close and primary actions reachable.
- Narrow windows: the tour list stacks above the preview, footer controls wrap, and content has one clear scroll region. The UI lays out its content rather than shrinking the desktop SVG. Acceptance viewports are 390 by 844 and 1024 by 600, including browser zoom behavior.
- Styling follows current tokens without a new palette. Decorative illustrations carry no essential information and are hidden from assistive technology. Reduced motion and the desktop no-drag rule apply.
- Empty catalog: automatic display is skipped; manual opening says No tours are available and keeps dismissal available. No enabled Start action appears. Current registry contracts normally make this defensive state unreachable.

## Architecture and flow

Today the browser hydrates UI config from the daemon and, for an unconsumed fresh profile, starts Setup directly. The proposal uses that same preference path to gate a catalog modal. The browser reads the tour registry locally; an explicit Start passes the selected ID to the existing preflight and walkthrough engine. Only preference changes write the new flag through the daemon to SQLite. Browsing the picker performs no tour-task requests. Existing walkthrough actions retain their current server routes.

![Startup and preference flow: daemon config gates the picker, local registry supplies tours, an explicit start reaches the existing engine, and checkbox saves return through the daemon](flow.svg)

## Repository findings and implementation route

| Owner | Verified baseline and proposed work |
| --- | --- |
| `src/web/tour/entries.ts` | Owns discovery metadata for all three tours. Proposed additions are catalog summary/outcomes, recommendation, and a generic decorative fallback for future entries. Title ownership remains in `tours/*.md`. |
| `src/web/tour/definitions.ts` and `contracts.ts` | Own the exhaustive tour definitions. Stop counts derive from each definition at the App/catalog adapter boundary; Settings and palette metadata remain free of driver/runtime imports. |
| `src/web/App.tsx` | Owns startTour, snapshots, active-run exclusion, and finishTour. The proposal replaces only the automatic start trigger and adds picker state, startup latch, captured invoker, palette action, and guarded handoff. Existing per-tour bindings remain. |
| `src/web/App.tsx`, `src/web/components/SetupBanner.tsx`, `src/web/components/SettingsRestoredBanner.tsx`, `src/web/styles.css` | App already renders banners outside AppPageShell on every route. The proposal adds App-owned preference save/error state and a small `TourPreferenceNotice.tsx` renderer in that region, using existing banner styles and narrow-screen stacking. This is the owned post-dismissal failure surface. |
| `src/web/useNotifier.ts` | Its private notify helper emits permission-gated desktop notifications for attention transitions. No general dashboard-toast API was found. Neither this hook nor App's launcher-specific error flash owns preference failures. |
| `src/web/lib/guided-tour.ts` | Implements the consumed one-time flag and retry marker. The picker startup gate supersedes this client path under the retirement prerequisites above; only one automatic starter remains. |
| `src/shared/protocol.ts`, `src/server/ui-config.ts`, `src/web/lib/uiConfig.ts`, `src/web/lib/uiCache.ts` | Existing schema, persisted UI blob, authoritative hydration, legacy adoption, and per-field write rollback. Schema extension and coverage for defaulting, round-trips, legacy adoption, and error behavior use this existing store. |
| New `src/web/components/TourPicker.tsx` and optional focused startup helper | Proposed ownership for rendering, selection, focus, and the small eligibility rule. Names are proposed, not existing APIs. Navigation and tour runtime ownership remain in App. |
| `src/web/components/Overlay.tsx`, `src/web/components/SettingsPage.tsx`, `src/web/lib/palette-index.ts`, `src/web/styles.css` | The proposal registers the dialog, adds Browse tours through established discovery/action patterns, styles the selected layout with current tokens, and extends the existing palette target union. |
| `e2e/fixtures/test.ts` and explicit browser/dev setup fixtures | Currently disable guidedTour for unrelated tests. The proposed startup-picker fixture option defaults off for unrelated tests; the dedicated startup spec opts in. Hand-built fixtures are included in the fixture inventory. |
| `e2e/specs/tour-engine.spec.ts` and existing tour specs | Two first-run tests currently assert automatic Setup and one-time consumption. Approved picker behavior replaces those assertions while engine, cleanup, Settings, and palette regressions remain. Fixed counts include the additional Browse tours control. |
| `docs/ui.md`, `README.md` | Planned documentation covers the startup picker, opt-out and scope, manual reopening, and continuing lack of progress/resume. Existing shipped behavior docs stay unchanged until the implementation lands. |

Confidence is high for these ownership findings: they were inspected in the current checkout. The router interface comment says a same-route navigation returns false, but the implementation returns true; the plan follows the implementation and requires a same-route launch regression. No unrelated router rewrite is proposed.

The proposed sequence is metadata/preference and focused checks, modal, automatic/manual entry points, walkthrough handoff and edge-case coverage, then product documentation. Any implementation phase breakdown is a follow-up decision, not a dependency on a separate engine rebuild.

## Verification and acceptance evidence

| Coverage | Cases and expected proof |
| --- | --- |
| TP-01, TP-05 | Unit/store/cache tests for missing/default/explicit-false preferences, legacy guidedTour values, stale cache before hydration, write rollback, and the per-document latch. Browser cases cover new profile, upgraded profile, reload, second window, saved opt-out, re-enable, delayed/failed hydration, and rejected saves. When a preference PUT is held through picker dismissal and navigation, then returns 503: the App banner reports failure without reopening or stealing focus; Browse tours shows the restored checkbox and inline error; a successful retry clears the error and persists. Related coverage includes inline failure, notice dismissal, pending reopen, and overlay/tour deferral. |
| TP-02, TP-03, TP-10 | Browser spec checks all registered titles/counts, selection-only preview updates, same-route starts, each chosen first stop, and one controller under rapid clicks. Unit tests derive metadata and stop counts from registries. |
| TP-04, TP-06 | All dismissal paths preserve route/state; Settings and palette reopen after opt-out; existing per-tour commands still start the selected tour. |
| TP-07, TP-09 | Keyboard selection, Tab containment, Escape and overlay precedence, focus restoration after dismissal/start/finish, reduced motion, theme parity, narrow/short viewport scrolling, and `expectContentClearsBorder` for the new dialog. Expected visual evidence consists of gitignored screenshots of the actual implementation. |
| TP-08 | Dirty editor Stay/Leave/start-again sequence; other-overlay deferral; active-tour exclusion; full Setup, Library, and See the work regressions including cleanup and Setup's Trust landing. |

Implementation acceptance includes a Playwright spec such as `e2e/specs/tour-picker.spec.ts`. Browser tests use the repository fixtures and fake agents for both CLI and SDK launch paths. Selectors use accessible roles, labels, or placeholders without data-testid attributes.

Validation references include the unit-test command contract in root AGENTS.md, existing UI-config store/cache/race tests, startup and catalog helper tests, overlay registry, palette, and affected setup/tour contracts. The following command examples identify expected future implementation evidence; they are not execution instructions for a reviewer:

```sh
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/tour-picker.spec.ts e2e/specs/tour-engine.spec.ts e2e/specs/setup-banner-and-tour.spec.ts e2e/specs/library-tour.spec.ts e2e/specs/see-work-tour.spec.ts
npm run test:e2e
```

A full browser-suite result after focused tests is part of initial feature acceptance because the startup default and shared fixture affect every dashboard visit. Repair and publication policy remains in repository-level instructions. These future implementation checks are not evidence that this planning task implements the feature.

Planning-artifact acceptance covers reproducible Markdown-to-HTML rendering, all three embedded mockups, zero network dependencies, and no horizontal page overflow in both themes at desktop and narrow widths. Review evidence consists of complete current plan text, relevant unchanged contracts, structured decisions, and rendered mockups, stored and registered under the active task's evidence policy.

## Supersession and boundaries

This plan supersedes only the direct one-time automatic Setup launch described in `docs/ui.md` under Guided tours and its first-run effect/tests. It preserves the registered tours, all walkthrough content, normal manual tour starts, server demo recipes, target readiness, cleanup, Setup's declared exit route, and the existing setup reminder banner. The banner may remain behind the picker and becomes visible on dismissal.

Plan Validation v1 repair on 2026-09-15, run `5a07bf04-605f-4442-82f0-2b1af91a7035`, round 1: the App-owned preference notice and delayed-rejection browser coverage replace the earlier unverified dashboard-toast wording. The approved layout, startup behavior, and MC-b64d.1 amendment to use Dismiss remain unchanged. This repair makes TP-05's failure surface concrete within the same phase.

No runtime changes, model calls, production configuration changes, new service, external dependency, or tour-task dispatch occur in this planning task. SVG mockups are intentional design deliverables; verification screenshots and transcripts are separate gitignored evidence.

## Approved follow-up

The operator approved this complete plan and requested phased implementation planning. Follow-up references: [phased implementation index](phased-plan.md) and [rendered review page](phased-plan.html). Implementation tasks depend on this planning session and remain backlogged until the planning pull request merges. This planning task does not implement the feature.

Inspector review amendment on 2026-09-15: agent-directed reading, editing, testing, and publication wording is replaced by declarative design and validation references. Existing repository instructions retain operational policy. TP-01 through TP-10, submitted choices, the preference-failure contract, and the single scheduled task are unchanged.
