# Phase 5: Setup and browser feedback

The approved source is `docs/plans/voice-addressing-on-linux/plan.md`. Read the implementation index `phased-plan.md` beside this file. Repository scope is mission-control.

## Outcome

The operator can diagnose voice from Setup and use the approved indicators and corner toast in the browser. A missing capability gives the right local remedy and does not suggest installing a Linux desktop app.

## Entry and direct dependencies

Planning publication, Linux 3, Linux 4, “Voice Addressing for Agents - Phase 6: Confirmation and outcome cards” and “Spoken Responses for Voice - Speech 4: The voice picker”. Review the referenced selected mock-ups and existing Playwright fixtures before edits.

## Scope

Own Linux-specific Setup observations, remedies, browser integration and rendered verification. Reuse the existing control surfaces and voice picker. Keep tray and floating windows unavailable. Leave capture, process ownership and speech computation with their existing producers.

## Implementation and compatibility

Extend the existing Voice family in the Setup catalog, daemon probes and SetupPanel. Keep recognition-model and speech-model readiness distinct. Expose the following observations and recovery actions with the existing row pattern.

- **Prerequisites and listener.** Show disabled previews, missing or verifying recognition model, unavailable graphical/audio session, failed launch, refused version, stale lease or recovery hold. Offer the existing flag/model remedies and a recheck after the underlying fault clears.
- **Microphone.** Distinguish untested, denied, no device, missing selected input and observed ready. Give Linux audio/session guidance and a recheck. A permission prompt for the Mac shell or the browser would target the wrong process.
- **Shortcut and auto-mute.** Show the actual binding, conflict and chord still in force, or the applicable portal/access limitation. Indicate when other-app capture detection is unavailable and how to use dashboard mute. Expired observations lose readiness.
- **Spoken replies.** Read the daemon’s resolved voice, speech model and live supervised player. Distinguish download needed, downloading/failed, no usable output device, unannounced/absent player and unconfirmed stop. Link the existing download/voice settings or recheck where appropriate. Keep the card visible when speech is unavailable. Preserve the upstream rules for Ask aloud and Play sample.
- **Presentation.** Use the selected references in `docs/plans/voice-addressing-for-agents/`: `mockup-enable-and-download.html#e` (Setup checks and Fix buttons), `mockup-voice-settings.html#e` (roster first), `mockup-dashboard-indicator.html` (all five selectable indicators, status line default), and `mockup-confirmation-card.html#a` (corner toast, including when a floating placement is saved). Use contract G’s existing card host when merged. Keep tray and floating-windows unavailable. Compare rendered layout, keyboard actions, capability changes, mute/hold and toast states against the selected variants. Surface any missing selection before changing its UI.

Extend src/shared/setup-catalog.ts using append-only IDs only where existing probes cannot represent distinct checks. Wire src/server/setup/index.ts and its injected dependencies to real state and row-specific freshness. Reuse the SetupPanel remedy patterns and VoiceSettingsPanel navigation. Use the confirmed registered chord in VoiceIndicators and the existing VoiceCardHost fallback. Preserve prior settings, absent capability semantics and the flag-off path. Verify a headless user, a bare browser on macOS and the macOS desktop still get their appropriate actions.

## Verification and merge criteria

Run `node --test --import ./test/setup-state.mjs --import tsx test/setup-probes.test.ts test/voice-model-setup-view.test.ts test/voice-indicators.test.ts`. Run `npm run build` then `npm run test:e2e` with new or extended specs for each changed row/action, live transitions, fallback toast for saved native placements and stale reports. Use fixture listeners, report producers and mock speech with no model tokens. Compare browser screenshots and interactions against the exact selected variants, including all five styles, default status line and corner placement. Verify keyboard reachability, focus, labels, narrow viewport, retry/download states and a reopened browser tab. With the operator’s desktop, address a resident, observe the toast, mute, hold during mic contention, hear a reply and use Setup to recover from device loss. Attach rendered evidence and the named environment support matrix. Update docs/voice.md and relevant Setup guidance.

Run the repository typecheck and lint. Run build and smoke for runtime changes, the applicable unit suite, and browser E2E for visible changes. Use Node 24 or newer and the test-state preload. Keep hardware results and screenshots in PR/workflow evidence. Record measured limitations in the technical guide. Merge when the outcome works through the stated entry point and its failure cases pass.

## Downstream handoff and cross-phase audit

Linux rollout readiness is the tested matrix of capture, hotkey, detection and output. The approved source and five phases are fully covered once these physical results and browser evidence exist. Report unavailable combinations explicitly.
