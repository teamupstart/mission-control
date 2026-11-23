# Speech 3: the macOS listener plays

Part of `docs/plans/voice-spoken-responses/phased-plan.md`. Source plan: `plan.md` beside this
file. "Phase n" is a phase of the voice plan. Owns playback on macOS, the system voices, the
hotkey stop and the leak check.

## 1. Outcome

On a Mac, the listener speaks the question: it stops capture, plays the daemon's audio or speaks
with a system voice, reports when it started and ended, and restarts capture. A tap of the mute
hotkey cuts the speech off. Ask aloud does not hear itself.

## 2. Entry criteria

Phases 10 and 11 and Speech 1 are merged. May run beside Speech 2.

## 3. Scope and non-goals

In scope: the Swift helper's speech side, its hello's `speech` part, the shell's hotkey rule,
the leak check, docs and tests.

Not in scope: synthesis (Speech 2), the picker (Speech 4), playback in the sherpa-onnx listener
and on Linux (the Linux follow-on).

## 4. Repository findings and inherited contracts

- Phase 9 builds the helper as a Swift package in `native/voice-listener/`, capturing with
  `AVAudioEngine`. Phase 10 starts it from the shell. Phase 11 turns a hotkey press and release
  within 350 milliseconds into a tap that toggles mute. Read each as merged; this plan saw them
  as documents.
- The spike's S9: with capture running, system speech leaked into the recognizer in 3 of 3
  trials; with capture stopped through playback it leaked in 0 of 6, and restarting capture
  cost 80 to 89 milliseconds. S9 measured the exit of `say`. It says a different completion
  callback needs another tail-leak check, which is step 6 here.
- Apple's licence allows system voices while running macOS and forbids recording them for
  redistribution, so system-voice audio is spoken live and never written or cached.
- An app cannot start the download of an Enhanced or Premium voice. The person does it in
  System Settings, under Accessibility, Read & Speak.
- No entitlement exists for audio output under the hardened runtime, so signing does not change.
- Inherited: contract L (the `speak` directive, the events route, the audio route, the hello's
  `speech` part, the stop route).

## 5. Implementation steps

1. **Speak an audio job.** When the directive's `speak` is an audio job: stop audio input,
   fetch the WAV from the audio route with the token, play it with `AVAudioPlayerNode`, post
   `started` when playback begins, and post `ended` as `finished` from the completion callback
   that fires when the audio has played out, not when it was scheduled.
2. **Speak a system job.** When `speak` is a system job: stop audio input and speak the text
   with `AVSpeechSynthesizer` and the named voice, posting `started` and `ended` from its
   delegate. Keep the synthesizer alive until it finishes. An unknown voice id is `ended` as
   `failed`.
3. **Stop and failure.** When `speak` becomes null or names another job mid-speech, stop
   playback and post `ended` as `stopped`. A fetch error, a playback error or an output device
   change that halts playback is `ended` as `failed`. Every path posts exactly one `ended`.
4. **Resume.** After `ended`, restart audio input only if the directive's `capture` is true, as
   a fresh recognition segment. Replay nothing buffered before the pause.
5. **Hello.** Send `speech { audio: true, systemVoices }` with the installed English voices,
   each with its identifier, name, language and quality tier.
6. **Leak check.** With the real helper on a Mac, loudspeakers and the built-in or a desk
   microphone: three trials with capture forced to stay on during an audio job, then three with
   the normal pause, then the same six with a system voice. Record what the recognizer heard in
   each. If a paused trial is heard, add a 250 millisecond delay before resuming and repeat. If
   it is still heard, the helper sends `audio: false` and lists no system voices, so
   `speech-output` stays unavailable; tell the operator and record the finding in
   `docs/voice.md`.
7. **Hotkey.** In the shell's tap handler from Phase 11: when the voice state shows a live
   speech job, a tap calls `POST /api/voice/speech/stop` and does not toggle mute. Otherwise
   it toggles mute as before.
8. **Docs.** `docs/voice.md` (system voices, how to install a better one, the leak check's
   result), `docs/desktop-and-packaging.md`.

## 6. Data and compatibility

Nothing stored. A helper built before this phase sends no `speech` part and the daemon reads it
as unable to play. The protocol's major version does not change.

## 7. Tests and verification

- Swift tests on macOS with a stub player and a stub synthesizer: the order stop, play, report,
  resume; one `ended` on each path; a stop mid-speech; no resume while `capture` is false.
- `test/voice-listener-protocol.test.ts` gains cases for `speak` against the fake listener.
- `test/voice-hotkey-tap.test.ts`: a tap stops speech while a job is live and toggles mute
  otherwise, as a pure function of the voice state.
- Manual check, recorded in the pull request: the leak check's twelve trials with what was
  heard; ask aloud with a system voice asks once and a spoken name picks; a hotkey tap stops it;
  unplugging headphones mid-speech returns capture.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:electron` and the
  tests.

## 8. Merge and exit criteria

On a Mac with a system voice chosen, an unsure card is asked aloud once, capture is off for the
life of the speech, and the recognizer did not hear the question in any paused trial. If the
leak check fails after the added delay, the phase merges with playback reported unavailable and
says so. The helper still builds on macOS arm64 and is skipped cleanly elsewhere.

## 9. Downstream handoff

Speech 4 lists the system voices this phase reports. The Linux follow-on implements steps 1, 3
and 4, and the `audio` flag of step 5, in the sherpa-onnx listener.

## 10. Cross-phase audit record

- The audit note in Phase 12 about S9 moves here, and is stricter: a leak that pausing cannot
  stop leaves Ask aloud unavailable, where Phase 12 said off by default.
- With Speech 2 unmerged, an audio job never arrives, and this phase is checked with system
  voices and a WAV served by a test daemon.
