# Phase 16: the sherpa-onnx backend

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V45.

## 1. Outcome

A second listener, built on sherpa-onnx, speaks the same protocol as the FluidAudio helper. On
macOS it is a working alternative to the default backend. On Linux its recognizer path is proven
in CI: the native addon loads and the listener transcribes recorded audio into utterances. It is
the first piece of voice on Linux. Microphone capture on a Linux desktop is not verified here; the
follow-on plan owns it.

## 2. Entry criteria

Phases 9 and 10 are merged. Phase 10 supplies the shell's listener supervisor, which step 4
changes.

## 3. Scope and non-goals

In scope: the backend, its model manifest entry, backend selection, its packaging on macOS, a
file-input mode for tests, a pinned recognizer test model, a required Linux CI test, docs. Not in
scope: starting a listener from the daemon on Linux, verifying microphone capture on a Linux
desktop, a Linux hotkey or call detection, a Linux desktop app. Those belong to the follow-on
plan.

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- No third-party native dependency ships: `electron-builder.yml` excludes `node_modules` and
  esbuild inlines JavaScript. A prebuilt addon has to be copied into `dist/` by a build script,
  through `publishNativeAddon`, to be packaged.
- Inherited: contract I and the fake listener (Phase 9), the hello (contract B), `VOICE_MODELS`
  and the manager (contract H), `backend` (contract A), the shell's listener supervisor (Phase
  10), and the spike's S2.

## 5. Implementation steps

1. **Listener.** `src/voice-listener/sherpa.ts`, bundled to `dist/voice-listener/sherpa.mjs`: a
   Node program that speaks contract I, captures audio with the package S2 chose, runs Silero
   voice activity detection and the Parakeet TDT 0.6B v2 int8 ONNX model through
   `sherpa-onnx-node`, primes names with hotwords, merges token timings into word timings and
   posts utterances. Like the Swift helper it stores nothing and closes the microphone when
   `capture` is false. A `--input-file <wav>` option feeds a recording through the same detection,
   recognition, word-merge and posting code in place of the microphone; it exists for tests and
   is refused by the packaged app.
2. **Packaging.** `scripts/build-voice-sherpa.mjs` copies the platform's prebuilt addon and its
   libraries into `dist/native/sherpa-onnx/` through the publish helper, for macOS arm64 and
   Linux x64 and arm64, and records their licences in `NOTICE`. `sherpa-onnx-node` becomes a
   dependency, so `npm install` on a Linux CI runner brings the Linux prebuilt addon the required
   test loads.
3. **Manifest.** The `sherpa-onnx` entry of `VOICE_MODELS`: the ONNX files and the detection
   model, pinned and digested as S2 recorded.
4. **Selection.** `backend` `auto` resolves to `fluidaudio` on macOS arm64 with macOS 14 or later
   and to `sherpa-onnx` elsewhere; either can be set explicitly through the config route or
   `MISSION_VOICE_BACKEND`. The model manager and the shell's supervisor follow the resolved
   backend. No new settings row is drawn.
5. **Launcher.** `npm run voice:listener -- --backend sherpa-onnx` runs it against the daemon on
   macOS or Linux.
6. **Recognizer test model and fixture.** `VOICE_TEST_MODEL` in `src/shared/voice-models.ts` pins
   the small English sherpa-onnx model S2 chose for testing: repository, commit, files, sizes and
   SHA-256, as for the real model. `test/fixtures/voice/steve-check-the-build.wav` is a short
   recording generated with `say`: a roster name, a 400 millisecond pause, then a message.
   `test/helpers/voice-test-model.ts` downloads the pinned files once into a cache directory under
   the temp dir, retrying a failed download twice, verifies each digest and reuses them. No CI
   configuration changes: the test fetches its own model.
7. **Docs.** `docs/voice.md` (backends, how to choose, what Linux has and lacks today),
   `docs/configuration.md`.

## 6. Data and compatibility

A second model directory under `<state home>/voice/models/sherpa-onnx/`. Switching backend
downloads that backend's model; the other's files are left in place.

## 7. Tests and verification

- `test/voice-listener-protocol.test.ts` runs its cases against this listener with a fake
  recognizer.
- `test/voice-sherpa-recognizer.test.ts`, the Linux proof. It loads the platform's sherpa-onnx
  addon, loads `VOICE_TEST_MODEL`, runs the listener with `--input-file` on the fixture recording
  against a test daemon, and asserts that the posted utterance carries the fixture's words in
  order, word timings, and a gap of at least `pauseMs` after the name. On Linux CI (`CI` set and
  the platform `linux`) the test is required and has no skip: a missing addon, a failed download
  or a digest mismatch fails it. It runs in the existing unit shards, so each pull request
  exercises it. On a developer machine it skips, with the reason, when the model cannot be
  fetched and is not cached.
- `test/voice-word-merge.test.ts`: the token-to-word merge, with no model.
- `test/voice-backend-select.test.ts`: `auto` on each platform and the explicit overrides.
- Manual check, recorded in the pull request: on a Mac with `backend` set to `sherpa-onnx`,
  speak to a resident and see the message arrive in its conversation. No manual Linux check is
  part of this phase; the required CI test above is its Linux validation.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the tests.

## 8. Merge and exit criteria

Both backends pass the same protocol tests. The packaged macOS app can run either. On Linux CI
the sherpa-onnx addon loads and the listener transcribes the fixture recording into the expected
utterance, and that test has passed on the pull request before this phase is called done.

## 9. Downstream handoff

The follow-on plan "Voice Addressing on Linux" starts from here: a daemon-run listener,
microphone capture verified on a Linux desktop, a Linux hotkey and Linux call detection behind
the shell-report fields of contract B.

## 10. Cross-phase audit record

- If S2 is no-go, this phase is not started and the operator is told; the first release does not
  depend on it.
- If S1 was no-go, this backend was built in Phase 9's place, and this phase builds FluidAudio
  when the operator still wants it.
- Plan validation round 1: Phase 10 is a direct prerequisite, because step 4 changes the
  supervisor that phase creates.
- Plan validation round 2: the real-recognizer test could be skipped and the Linux check was "where
  a desktop is at hand", so nothing proved the addon runs on Linux. Step 6 pins a test model and
  a fixture, the recognizer test is required on Linux CI, and the outcome now claims what that
  test proves and leaves Linux microphone capture to the follow-on plan.
