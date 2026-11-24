# Phase 3: Global mute and call detection

The approved source is `docs/plans/voice-addressing-on-linux/plan.md`. Read the implementation index `phased-plan.md` beside this file. Repository scope is mission-control.

## Outcome

The shortcut works while another application has focus. Another client using a physical microphone auto-mutes voice, and holding the chord temporarily permits bounded speech. Setup will be able to explain each unsupported capability separately.

## Entry and direct dependencies

Planning publication, Linux 2 and “Voice Addressing for Agents - Phase 11: Hotkey, call auto-mute and push-to-talk”. Recheck the merged threshold, stop semantics and time headers. Arrange X11 coverage and identify each actual Wayland compositor/portal to qualify.

## Scope

Own one desktop report producer, X11 and portal registration, and PipeWire/PulseAudio observation. Preserve browser-only presentation. Do not add a press-only global fallback, a keyboard-event logger or an audio player.

## Implementation and compatibility

Implement platform adapters beside the Linux daemon voice integration. Feed their readings into the established report schema and voice state path; use existing mute/stop actions. Source physical key and audio times on a compatible clock and verify bounds before permitting held delivery. Obtain the listener’s identity from Linux 2. Document tested stacks and their limits in docs/voice.md.

Use one Linux producer of complete contract B snapshots so an idle hotkey heartbeat cannot overwrite call detection. Send transitions promptly and refresh within the 15-second report lifetime. Use the existing config, mute operation, voiceMode precedence, registeredHotkey, hotkeyError, callActive and pushToTalk. Order observation and physical key edges on the Linux CLOCK_MONOTONIC microsecond timebase. Retain the last release stamp across heartbeats. A missing release, disconnect, session lock, rebind or stale report clears a held state and discards an unprovable tail. Keep explicit mute authoritative.

On X11, passively grab only the configured chord in the user’s X session. Handle press/release, modifier variants, auto-repeat, layout changes and conflicting grabs. Release old registrations on disable or exit. Apply the shared tap/hold behavior: tap within 350 ms toggles mute once, a longer hold talks through call auto-mute only while held. Preserve the old chord on failed replacement where it remains registered, otherwise report no chord in force. Reflect the actual binding. When speech is active, honor the Speech 1 hotkey stop behavior.

On Wayland, exercise GlobalShortcuts CreateSession, BindShortcuts, consent, returned bindings, Activated, Deactivated, changes, revocation and session loss from the unpackaged daemon. Verify desktop identity and consent presentation without a native parent window. The portal may choose a different trigger and specifies milliseconds with an undefined base. Establish a defensible mapping of physical event time to the audio clock, including delayed delivery, or withhold the capability. Verify equivalent time conversion and wraparound for X11 event times. A callback receipt timestamp cannot establish an earlier physical release. Offer the keycap only for a current confirmed matching chord. Never use an XWayland grab as proof of global Wayland support. [Portal interface](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)

For call detection, observe active audio capture by another client on a physical microphone. On PipeWire inspect running stream nodes and links to input sources. On PulseAudio inspect uncorked source outputs and their source/client identity. Probe each supported path, including whether a Pulse compatibility server sees native PipeWire clients. Use one authoritative observer per session with a baseline snapshot, change subscription and rescan on reconnection. Exclude this listener and its capture helper, sinks, monitor/loopback sources and idle streams. Another recorder counts even without a call. Test two simultaneous clients, the first leaving, the second leaving, and background speaker playback. Report unavailable with a reason where permissions, attribution or stack visibility prevent a reliable result. The existing toggle governs auto-mute. Dashboard mute remains available independently. [PipeWire observation](https://docs.pipewire.org/page_man_pw-dump_1.html) · [PulseAudio introspection](https://www.freedesktop.org/software/pulseaudio/doxygen/introspect_8h.html)

## Verification and merge criteria

Run `node --test --import ./test/setup-state.mjs --import tsx test/voice-state.test.ts test/voice-hotkey-shown.test.ts test/voice-utterances-http.test.ts` plus injected report/portal/X11/audio observer cases. Test timer boundaries, repeat and modifier ordering, rollback after conflict, denial/revocation, release lost during a held word, portal session replacement, and an out-of-order heartbeat. On real X11 and each claimed Wayland desktop, use a second app, speak before/during/after a hold and inspect delivered words. Test native and compatibility-server visibility, two recording clients, monitor streams and logout. Record which combinations earn availability and the exact reason for others.

Run the repository typecheck and lint. Run build and smoke for runtime changes, the applicable unit suite, and browser E2E for visible changes. Use Node 24 or newer and the test-state preload. Keep hardware results and screenshots in PR/workflow evidence. Record measured limitations in the technical guide. Merge when the outcome works through the stated entry point and its failure cases pass.

## Downstream handoff and cross-phase audit

Linux 5 consumes capability availability/reason, current chord, call and hold state through B. No new persisted field. This phase owns no playback code and consumes no Linux 4 changes. An unsupported observation never masquerades as a confirmed negative reading.
