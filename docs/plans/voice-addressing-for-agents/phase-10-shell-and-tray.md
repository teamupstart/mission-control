# Phase 10: shell supervision and the tray

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V4 and V8. Mock-up: `mockup-tray-states.html`.

## 1. Outcome

The desktop app starts the listener itself, asks for the microphone, keeps listening while
minimized, and shows the voice mode in the tray icon, where a click mutes.

## 2. Entry criteria

Phase 9 is merged.

## 3. Scope and non-goals

In scope: supervision, microphone permission, the signing changes the operator authorized, the
shell's view of voice state, tray glyphs and menu rows, docs and tests. Not in scope: the hotkey
and call detection (Phase 11), floating windows (Phase 12).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- Background services start in `ownElectronBackgroundStart` (`src/main/daemon-policy.ts:41-85`) and
  stop in reverse; `superviseUtilityProcess` (`src/main/utility-supervisor.ts:37-118`) forks Node
  entries, so a native binary needs a sibling supervisor with the same restart policy.
- The tray is `src/main/tray.ts`: a template image, `setTitle` for the need-you count, a context
  menu, a 3 second poll, and click bound to Open Dashboard.
- Tray images come from `scripts/gen-icons.mjs`.
- `build/entitlements.mac.plist` and `electron-builder.yml`'s `extendInfo` hold no microphone
  entry; the signed build is configured in `scripts/package-distribution.mjs:27-35` and checked
  by `scripts/verify-distribution.mjs:48-70`. The shell grants web permissions for notifications
  and nothing else (`src/main/index.ts:392-394`).
- Inherited: contract I's binary, `POST /voice/shell-report` and the mute route (contract B),
  `VoiceState.model` (contract H), and the spike's S4.

## 5. Implementation steps

1. **State in the shell.** `src/main/voice-state.ts` subscribes to the daemon's event stream for
   `voice_state` and `voice_card`, with reconnect, and exposes the current state to the tray and,
   later, the windows. It sends a shell report at a 5 second interval and on change.
2. **Supervisor.** `src/main/voice-listener.ts` starts `dist/native/voice-listener` with contract
   I's environment while the mode is not `off` and the model is `ready`, restarts it with the
   utility supervisor's backoff, and stops it on quit before the daemon.
3. **Microphone.** Read `systemPreferences.getMediaAccessStatus("microphone")` into the shell
   report. The `voice-microphone` Setup row's Fix calls a new preload method that runs
   `askForMediaAccess`, or opens System Settings after a denial.
4. **Signing.** Add `com.apple.security.device.audio-input` to `build/entitlements.mac.plist` and
   `NSMicrophoneUsageDescription` to `extendInfo`, placed as S4 found, and make
   `verify-distribution.mjs` fail when either is missing.
5. **Tray glyphs.** Generate four template images (microphone, struck microphone, handset,
   microphone with waves) beside the existing one. While the mode is not `off`, the tray shows the
   glyph for the mode and keeps the need-you count in its title; when `off` it is as today.
   `unavailable` uses the struck microphone.
6. **Tray clicks.** While the mode is not `off`: left click toggles mute through the mute route;
   right click pops the menu up; `setContextMenu` is not set. The menu gains a first line with the
   mode and a Mute or Unmute row. When `off`, the tray behaves as today.
7. **Capabilities.** Report `tray` and `microphone`.
8. **Docs.** `docs/voice.md`, `docs/desktop-and-packaging.md`, `docs/release-verification.md`.

## 6. Data and compatibility

No storage. With the flag off the shell starts no listener, asks for nothing and the tray is
unchanged. A build without the helper binary reports the `listener` reason.

## 7. Tests and verification

- `test/voice-listener-supervisor.test.ts`: start, restart backoff, stop order, no start while
  `off` or while the model is not ready.
- `test/voice-tray.test.ts`: the glyph and menu chosen for each mode, as pure functions.
- `test/voice-shell-electron.test.ts`, in the pattern of
  `test/startup-notice-window-electron.test.ts`: the tray is created with each image; a click
  handler calls mute.
- The distribution verifier's tests cover the two new keys.
- An e2e spec: with a fake shell report granting the microphone, the `voice-microphone` Setup row
  passes; with a denial it offers Open System Settings and the mode reads unavailable.
- Manual check on a signed build, recorded in the pull request: the prompt names Mission Control;
  voice keeps routing while the window is minimized; the tray glyph follows mute.

## 8. Merge and exit criteria

The packaged app starts and stops the listener with itself. The signed build can open the
microphone. The tray shows the mode and a click mutes.

## 9. Downstream handoff

Phase 11 adds the hotkey and call signals to the same shell report. Phase 12 reads the shell's
card state for its windows.

## 10. Cross-phase audit record

- The signing change is the one the operator authorized on 2026-11-22; no other release or CI
  configuration changes here.
- After Phase 11: push-to-talk and auto-mute glyphs become reachable; this phase draws them.
