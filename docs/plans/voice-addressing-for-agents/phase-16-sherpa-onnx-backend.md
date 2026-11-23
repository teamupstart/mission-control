# Phase 16: the sherpa-onnx backend

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V45.

## 1. Outcome

A second listener, built on sherpa-onnx, speaks the same protocol as the FluidAudio helper and
runs on macOS and Linux. It is the first piece of voice on Linux and a recognizer the Linux CI can
run.

## 2. Entry criteria

Phases 9 and 10 are merged. Phase 10 supplies the shell's listener supervisor, which step 4
changes.

## 3. Scope and non-goals

In scope: the backend, its model manifest entry, backend selection, its packaging on macOS, a
Linux CI test, docs. Not in scope: starting a listener from the daemon on Linux, a Linux hotkey or
call detection, a Linux desktop app. Those belong to the follow-on plan.

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
   `capture` is false.
2. **Packaging.** `scripts/build-voice-sherpa.mjs` copies the platform's prebuilt addon and its
   libraries into `dist/native/sherpa-onnx/` through the publish helper, for macOS arm64 and
   Linux x64 and arm64, and records their licences in `NOTICE`.
3. **Manifest.** The `sherpa-onnx` entry of `VOICE_MODELS`: the ONNX files and the detection
   model, pinned and digested as S2 recorded.
4. **Selection.** `backend` `auto` resolves to `fluidaudio` on macOS arm64 with macOS 14 or later
   and to `sherpa-onnx` elsewhere; either can be set explicitly through the config route or
   `MISSION_VOICE_BACKEND`. The model manager and the shell's supervisor follow the resolved
   backend. No new settings row is drawn.
5. **Launcher.** `npm run voice:listener -- --backend sherpa-onnx` runs it against the daemon on
   macOS or Linux.
6. **Docs.** `docs/voice.md` (backends, how to choose, what Linux has and lacks today),
   `docs/configuration.md`.

## 6. Data and compatibility

A second model directory under `<state home>/voice/models/sherpa-onnx/`. Switching backend
downloads that backend's model; the other's files are left in place.

## 7. Tests and verification

- `test/voice-listener-protocol.test.ts` runs its cases against this listener with a fake
  recognizer.
- `test/voice-sherpa-recognizer.test.ts`, on Linux and macOS: the spike's generated audio files
  through the real recognizer with a small fixture model where one exists, otherwise skipped with
  the reason when the model is absent; the token-to-word merge is tested without a model.
- `test/voice-backend-select.test.ts`: `auto` on each platform and the explicit overrides.
- Manual check, recorded in the pull request: on a Mac with `backend` set to `sherpa-onnx`,
  speak to a resident and see the message arrive in its conversation; where a Linux desktop is at
  hand, the same with the launcher.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the tests.

## 8. Merge and exit criteria

Both backends pass the same protocol tests. The packaged macOS app can run either. On Linux the
listener runs from the launcher against a daemon.

## 9. Downstream handoff

The follow-on plan "Voice Addressing on Linux" starts from here: a daemon-run listener, a Linux
hotkey and Linux call detection behind the shell-report fields of contract B.

## 10. Cross-phase audit record

- If S2 is no-go, this phase is not started and the operator is told; the first release does not
  depend on it.
- If S1 was no-go, this backend was built in Phase 9's place, and this phase builds FluidAudio
  when the operator still wants it.
- Plan validation round 1: Phase 10 is a direct prerequisite, because step 4 changes the
  supervisor that phase creates.
