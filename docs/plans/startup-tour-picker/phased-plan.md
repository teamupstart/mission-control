# Startup tour picker: implementation phase

Status: approved source decomposed into one implementation and merge unit. Source: [approved plan](plan.md), [rendered plan with three mockups](plan.html). The operator selected B, approved every new window/reload with an opt-out for new and existing users, approved the full plan, and requested this phased follow-up.

## Sizing and phase-count rationale

Estimated gross production work: **450 to 750 added or materially changed lines**, excluding tests and planning artifacts. This includes approximately 180 to 280 lines for the modal and decorative previews, 110 to 180 for CSS, 110 to 200 for launch/focus/preference integration, and 50 to 90 for metadata, schema, and manual discovery. These ranges assume reuse of the existing tour engine, router, overlay host, UI-config store, and daemon endpoints. They are a planning signal, not a promised diff size.

Create **one one-shot implementation task**. The risk is concentrated in one lifecycle boundary: startup eligibility must transfer ownership to a modal and then to an existing tour. Splitting metadata, persistence, and UI would create a dormant feature or two automatic onboarding paths between merges. The shared infrastructure already exists; a single vertical slice is feasible for one implementation agent. Tests, compatibility handling, documentation, and removal of the superseded browser consumer belong in this phase.

## Phase and repository scope

| Phase | Outcome | Direct merge prerequisites | Detailed guide | Task |
| --- | --- | --- | --- | --- |
| 1 | The complete registry-backed startup picker, preference, manual reopening, and safe walkthrough handoff | This planning session's PR merged to main | [Phase 1: startup picker and walkthrough handoff](phase-1-startup-picker.md) | Pending publication and scheduling |

Repository: `teamupstart/mission-control`, canonical local repository `/Users/jordanmance/workspace/mission-control`. No additional repositories and no context-only attachments. One implementation PR completes the phase.

## Dependency graph and execution order

```text
Planning session PR merged to main
                  |
                  v
Phase 1: startup picker and walkthrough handoff
```

The only edge is the current planning session to Phase 1. No other implementation phases exist, so no phases execute concurrently and there are no transitive dependencies to flatten. The task must set dependsOnCurrentSession to true and have no task-ID prerequisites.

All root, index, phase, rendering, and mockup files are committed and pushed before scheduling. Verify every path in the task against the pushed commit. The planning PR's merge publishes the paths to main and releases the task; a merely pushed plan does not release it. Human merge remains the final publication action after CI and review.

## Investigated findings and reconciliations

- `TOUR_ENTRIES` and `TOUR_DEFINITIONS` already register all three tours. The catalog is browser-local; no catalog service or authoring feature is required.
- App's `startTour` already returns acceptance and synchronously guards against a second active run. Its resource bindings, cleanup, and declared Setup exit remain authoritative.
- The router's same-route implementation returns true despite an outdated interface comment. Phase 1 tests the actual accepted behavior and does not introduce a replacement router.
- The router's dirty confirmation stores only a route, not a deferred launch callback. The approved plan therefore keeps the picker below that confirmation and requires Start again after Leave. No automatic launch is inferred from a route confirmation.
- `guidedTour` currently means unconsumed one-time onboarding. It is incompatible with every-open behavior, so Phase 1 introduces the approved separate flag, retires the browser consumer, and preserves serialized compatibility.
- `Overlay` supplies stacking and dismissal, but not a general focus trap. Phase 1 explicitly owns focus containment and handoff rather than assuming the shell supplies them.
- The UI-config store hydrates from the daemon and rolls back rejected field writes. No cross-window live sync exists; new windows read the saved value and already-open windows do not need synchronization for this feature.
- Shared E2E fixtures currently suppress guidedTour. Phase 1 updates those fixtures and hand-built settings seeds for the new default, preventing the modal from unexpectedly covering unrelated browser tests.
- There are no worker, packaging, native, release, or CI changes required. Existing server tour recipes and their token-consuming behavior remain behind the explicit walkthrough launch.

## Stable contracts

All of these are owned once by Phase 1 and inherited from the approved root plan:

| Contract | Ownership and compatibility |
| --- | --- |
| Catalog and recommendation | Existing tour registry, no copied tour list; title source remains tours Markdown; stop count derives from definition stops. |
| Startup preference | `showToursOnStartup`, boolean default true including upgraded profiles; explicit false persists in existing app_config.ui. Legacy guidedTour is not the new eligibility gate. |
| Launch | Existing startTour preflight, one active run, accepted launch closes picker, rejected launch leaves the existing route confirmation authoritative. |
| Overlay and focus | Shared overlay registration, picker-only focus containment while topmost, origin bookmark passed to the engine, no unmount refocus during handoff. |
| Exit and resources | Existing tour cleanup and snapshot behavior, including Setup on Trust. No automatic picker reopening after a tour. |
| Scope | All registered tours; no editor, saved progress, new tours, new services, or live cross-window preference synchronization. |

## Requirement ownership audit

| Root requirement | Sole owner | Exit evidence |
| --- | --- | --- |
| TP-01 startup eligibility | Phase 1 | Hydration, reload/window, disabled preference, overlay, and rerender checks |
| TP-02 full catalog and preview | Phase 1 | Registry/count checks and browser selection |
| TP-03 explicit safe launch | Phase 1 | Each actual tour and double-start test |
| TP-04 dismissal | Phase 1 | Four dismissal paths, unchanged route/state |
| TP-05 durable opt-out | Phase 1 | Store/cache upgrade and browser save/reload/failure cases |
| TP-06 manual discovery | Phase 1 | Settings and palette opening, retained direct entries |
| TP-07 focus and stacking | Phase 1 | Keyboard, overlay ordering, launch/dismiss/exit focus |
| TP-08 existing engine contracts | Phase 1 | Dirty preflight, three complete walkthrough regressions and cleanup |
| TP-09 responsive accessible layout | Phase 1 | Insets, theme, reduced-motion, short/narrow runtime checks and screenshots |
| TP-10 tests and documentation | Phase 1 | Focused and full browser runs, updated product docs |

The B layout, every-open upgrade behavior, and opt-out decisions are each implemented only in Phase 1. Root approval and the follow-up selection authorize this decomposition; they do not authorize feature implementation in this planning session.

## Verification and cross-phase audit

Phase 1's guide contains execution steps and exact verification commands. Completion requires focused unit and browser tests, typecheck, lint, build, smoke, the full browser suite after focused checks, and current product documentation. Runtime screenshots and exact command results must be registered as gitignored evidence. CI/workflow repairs use targeted tests instead of rerunning the full suite before each fix.

Final audit on 2026-09-15: reread the approved root plan and Phase 1; every TP requirement has one owner, each submitted choice is retained, no consumer precedes a prerequisite, and the final state needs no later cleanup phase. The interface-comment discrepancy, legacy preference distinction, missing general focus trap, fixture default, and route-confirmation behavior are reconciled above and in Phase 1. No root behavior was changed during decomposition.
