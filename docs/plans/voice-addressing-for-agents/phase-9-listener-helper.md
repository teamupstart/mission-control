# Phase 9: the listener helper

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V10 and V34.

## 1. Outcome

A standalone listener program hears the microphone, transcribes speech with Parakeet through
FluidAudio and posts utterances to the daemon. Started by hand, with the model downloaded, a
sentence spoken on a development Mac reaches the named agent as a queued message.

## 2. Entry criteria

Phases 0, 3 and 8 are merged.

## 3. Scope and non-goals

In scope: contract I, the daemon's directive route, the Swift helper, its build, a development
launcher, docs and tests. Not in scope: starting it from the app, microphone permission prompts
and signing (Phase 10), the second backend (Phase 16).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- No Swift code is built today. Native code is built by scripts under `scripts/` and published
  into `dist/native/` by `publishNativeAddon`, by rename and not by copy onto the published path
  (see AGENTS.md on why).
- `electron-builder.yml` ships `dist/**/*` with `asar` off, so a file in `dist/native/` is
  packaged.
- Inherited: the hello route and the mode (contract B), `POST /voice/utterances` (contract D),
  the roster (contract C), `inputDevice` (contract A), the model directory (contract H), and the
  spike's S1, S3 and S8.

## 5. Implementation steps

1. **Directive route.** `GET /voice/listener/directive` (token), a long poll of up to 25 seconds.
   `capture` is true while the mode is `listening` or `push-to-talk`; `roster` is the spoken
   names; `pauseMs` is the spike's value; a change in any field ends the poll.
2. **Helper.** A Swift package in `native/voice-listener/`: capture with AVAudioEngine from the
   directed device with voice processing off; voice activity detection; transcription of each
   speech segment with FluidAudio's Parakeet TDT 0.6B v2; name priming from the roster; word
   timings; one posted utterance per segment. It sends contract B's hello with whether a model is
   loaded and what the microphone permission is. With `capture` false it stops audio input, so the
   microphone is closed. It writes no audio or text to disk and logs no transcript.
3. **Devices.** The hello lists input devices with whether each is built in or Bluetooth.
   `built-in` selects the built-in microphone when one exists.
4. **Build.** `scripts/build-voice-listener.mjs` runs `swift build -c release` on macOS arm64 and
   publishes the binary to `dist/native/voice-listener` through the publish helper. On another
   platform it prints that it skipped and exits 0. `npm run build:native` calls it.
5. **Launcher.** `npm run voice:listener` starts the built helper against the running daemon with
   contract I's environment, for development and the manual check.
6. **Fake listener.** `test/helpers/fake-voice-listener.ts` speaks contract I, for the daemon's
   tests and for Phase 10's.
7. **Docs.** `docs/voice.md` (the protocol, privacy, how to run it), `CONTRIBUTING.md` (the Swift
   toolchain).

## 6. Data and compatibility

Nothing stored. The helper's hello carries the protocol version that Phase 1's route checks.

## 7. Tests and verification

- `test/voice-listener-protocol.test.ts` with the fake listener, on Linux and macOS: a directive
  change on mute, a roster change, the poll timing out, an utterance accepted and one dropped
  while muted.
- Swift tests on macOS, fed the spike's generated audio files: a name and pause is transcribed
  with a gap of at least `pauseMs`; a primed roster name is spelled as primed; silence produces no
  utterance.
- Manual check, recorded in the pull request: with the model downloaded and the helper started,
  say "<resident>, check the build"; after the cancel window the message is in the resident's
  conversation and `GET /api/voice/heard` lists the utterance; mute closes the microphone (the
  macOS orange dot goes out). No card is drawn at this point: the toast is Phase 6's.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the tests.

## 8. Merge and exit criteria

The helper builds on macOS arm64 and is skipped cleanly elsewhere. CI on Linux passes without
Swift. Speaking to a resident on a development Mac delivers a message.

## 9. Downstream handoff

Phase 10 starts and stops this binary. Phase 16 implements contract I a second time. The helper
reads contract I and nothing else, so whoever starts it needs no Electron.

## 10. Cross-phase audit record

- If S1 is no-go, see Phase 8's audit record: the sherpa-onnx backend is built here instead.
- After Phase 12: capture is paused through the directive while the system voice speaks.
- Plan validation round 1: the manual check uses the queued message and the Recently heard
  route, which Phase 3 built, and no longer a toast.
