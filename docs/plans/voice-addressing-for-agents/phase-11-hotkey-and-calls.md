# Phase 11: hotkey, call auto-mute and push-to-talk

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V6, V7 and V37. Mock-up: `mockup-voice-settings.html`.

## 1. Outcome

A system-wide hotkey mutes voice from any app. While another app uses the microphone, voice mutes
itself, and holding the hotkey talks through it.

## 2. Entry criteria

Phase 10 is merged.

## 3. Scope and non-goals

In scope: two native addons, the tap and hold rule, the hotkey setting, docs and tests. Not in
scope: Linux equivalents (the follow-on plan).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- Electron's `globalShortcut` gives a press and no release, and nothing in `src/` uses it.
- The addon precedent is `native/keep-awake` (Objective-C++), built by
  `scripts/build-keep-awake-native.mjs`, published by `publishNativeAddon` and loaded as
  `src/server/keep-awake-native.ts` does. `test/native-addon-publish.test.ts` refuses a builder
  that copies onto the published path.
- Chords are captured in the dashboard by `KeyboardPanel` with `chordFromEvent`
  (`src/web/lib/keybindings.ts:481`).
- Inherited: `hotkey` and `autoMuteDuringCalls` (contract A); `callActive`, `pushToTalk` and
  `hotkeyError` in the shell report and `voiceMode` (contract B); the spike's S5 and S6.

## 5. Implementation steps

1. **Hotkey addon.** `native/voice-hotkey/`: register one chord with the Carbon hot-key API and
   call back on press and on release; unregister; report a failed registration. Built for macOS
   and loaded by the shell.
2. **Tap and hold.** In the shell: a press and release within 350 milliseconds is a tap, which
   toggles mute. A longer hold sets `pushToTalk` in the shell report while held. `voiceMode`
   honours push-to-talk during auto-mute, as Phase 1 defines; elsewhere a hold does nothing.
3. **Registration.** The shell registers the chord from the config and re-registers when it
   changes. On failure it keeps the previous chord registered and reports `hotkeyError` as
   contract B shapes it, with the reason and the chord still in force. When
   the first registration fails, of the default `ctrl+alt+m` for instance, there is no previous
   chord: none is in force, and the row in step 5 says so. A null `hotkey` registers nothing.
4. **Call addon.** `native/mic-activity/`: on macOS 14.2 or later, list the processes with running
   audio input, leave out the listener's own process and the app's, and return whether any
   remain. The shell polls at the spike's interval and reports `callActive`. On an older macOS the
   `call-detection` capability reads unavailable with the reason, and auto-mute does not engage.
5. **Setting.** A Mute hotkey row in Voice settings using the keyboard panel's capture control. It
   saves through the config route. When the shell reports `hotkeyError`, the row shows the
   warning and names the chord still in force. Without the `hotkey` capability the row reads
   "Needs the desktop app". The auto-mute row gains the unavailable reason.
6. **Capabilities.** Report `hotkey` and `call-detection`. Reporting `hotkey` is what makes
   Phase 7's indicators print the keycap, through `hotkeyShown`; a `hotkeyError` hides it again.
7. **Docs.** `docs/voice.md` (what auto-mute can and cannot know about a call), `docs/ui.md`.

## 6. Data and compatibility

No storage beyond the config. The addons are built on macOS and skipped elsewhere, as the
keep-awake addon is.

## 7. Tests and verification

- `test/voice-hotkey.test.ts`: the tap and hold rule with a fake clock; a failed registration
  keeps the old chord; a failed first registration leaves none in force; a null `hotkey`
  registers nothing.
- Additions to `test/voice-state.test.ts`: push-to-talk during a call, a tap during a call,
  auto-mute off.
- `test/native-addon-publish.test.ts` covers the two new builders.
- `e2e/specs/voice-hotkey-setting.spec.ts`: with a fake shell report offering the capability,
  capture a chord and see it saved; a reported `hotkeyError` shows the warning; a reported call
  turns the mode line at the top of Voice settings (Phase 1's) to auto-muted, and a reported
  hold to push-to-talk.
- Manual check on a Mac, recorded in the pull request: tap from another app; join a call and see
  auto-mute; hold to talk; leave the call.

## 8. Merge and exit criteria

The hotkey mutes from another app. A call auto-mutes and a hold talks through it. A chord the
system refuses leaves the old one working.

## 9. Downstream handoff

Phase 7's keycap prints the configured chord. The follow-on Linux plan supplies other
implementations behind the same shell-report fields.

## 10. Cross-phase audit record

- If S5 is no-go, the operator is asked whether to ship tap-only on `globalShortcut`; this file's
  steps 1 and 2 change and V7's push-to-talk is deferred.
- If S6 is no-go, `call-detection` reads unavailable on each macOS version and V7's auto-mute is
  deferred.
