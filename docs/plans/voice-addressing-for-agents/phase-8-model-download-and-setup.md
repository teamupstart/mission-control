# Phase 8: model download and setup

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V35 and V46. Mock-up: `mockup-enable-and-download.html`.

## 1. Outcome

The Setup panel's Voice family downloads the speech model with visible progress, verifies it, and
reports a missing or broken model. Voice settings has an input device choice.

## 2. Entry criteria

Phases 0 and 1 are merged. May run beside phases 2 to 7.

## 3. Scope and non-goals

In scope: contract H, the download, the two Setup rows, the input device row, attribution, docs
and specs. Not in scope: loading the model (Phase 9), asking macOS for the microphone (Phase 10).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- `downloadBinaryAsset` (`src/main/update-binary-download.ts:10-54`) is the precedent: it hashes
  while it writes, enforces the declared size, reports bytes and can be aborted. It lives in the
  shell and fetches through `gh`; this phase needs the same shape in the daemon over HTTPS.
- The state home is `stateDir()` (`src/shared/harness-runtime.mjs:70-78`).
- Setup rows are `SetupDependencyInfo` entries with a probe (`src/shared/setup-catalog.ts:296`,
  `src/server/setup/index.ts:488`), drawn by `SetupRow` (`src/web/components/SetupPanel.tsx:779`).
- Inherited: the `voice` family and `voice-previews` row, `VoiceState.model` and the hello and
  shell report (contract B), `inputDevice` and `backend` (contract A), and the spike's pinned
  repositories and digests.

## 5. Implementation steps

1. **Manifest.** `VOICE_MODELS` in `src/shared/voice-models.ts`: per backend, a revision id and a
   list of files, each with a Hugging Face URL pinned to a commit, its size and its SHA-256. This
   phase fills the `fluidaudio` entry from the spike. A test fails on a URL that is not pinned.
2. **Manager.** A server `VoiceModelManager`: download each file to a temporary name beside its
   destination, hash while writing, refuse a size or digest mismatch, rename into place, and keep
   `VoiceState.model` current. A partial download is removed on failure or cancel. At start, and
   before it reports a model already on disk as `ready`, it hashes each file again and compares
   it with the manifest's SHA-256, reading `verifying` meanwhile. A missing file reads `missing`;
   a wrong size or digest reads `failed` with Retry. No stored record stands in for the hash.
3. **Routes.** Contract H's download and cancel routes. The base URL can be overridden by
   `MISSION_VOICE_MODEL_BASE_URL` so tests serve small fixture files.
4. **Setup rows.** `voice-model` with a new remedy kind `voice-model-download`: Download, a
   progress bar with bytes and speed, Cancel, then "Verified", or the error with Retry.
   `voice-microphone` with a new remedy kind `microphone-access`: its probe reads the microphone
   permission from the latest hello or shell report and, until one arrives, reads "Not checked
   yet". Both are optional checks.
5. **State.** `VoiceState.model` reports the download. The `model` reason stays the listener's, as
   contract B defines it: a listener that finds no verified model says so in its hello.
6. **Input device.** A Voice settings row: Built-in microphone (default), macOS default input, or
   a device from the list in the latest hello; with no listener the list holds the first two.
7. **Attribution.** The model's licence (CC-BY-4.0) and source in `NOTICE` and `docs/voice.md`.
8. **Docs.** `docs/voice.md`, `docs/setup.md`, `docs/storage.md` (the new directory and its size).

## 6. Data and compatibility

Files under `<state home>/voice/models/`, outside SQLite and settings backups. A new revision in
the manifest downloads beside the old one, which is removed after the new one verifies.

## 7. Tests and verification

- `test/voice-models.test.ts`: the manifest's shape and pinning.
- `test/voice-model-download.test.ts` against a local fixture server: success, a digest mismatch,
  a short file, cancel, a retry after failure, verification at start, and a file altered on
  disk without changing its size, which is refused at the next start.
- `e2e/specs/voice-model-setup.spec.ts`, with the fixture base URL: the row reads missing;
  Download shows progress then Verified; a corrupt fixture shows the error and Retry; the
  microphone row reads "Not checked yet".
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

A verified model is on disk after Download. A tampered file is refused. No test downloads the
real model.

## 9. Downstream handoff

Phase 9 reads the verified directory through `MISSION_VOICE_MODEL_DIR`. Phase 10 starts a listener
once `VoiceState.model` is `ready`. Phase 16 adds the `sherpa-onnx` manifest entry and changes
nothing else here.

## 10. Cross-phase audit record

- If S1 is no-go, this phase fills the `sherpa-onnx` entry instead and Phase 16's backend moves
  ahead of Phase 9's; the operator is asked before that swap.
- After Phase 10: the microphone row's Fix asks macOS or opens System Settings.
- Plan validation round 1: the start-up check hashes the files instead of trusting sizes and a
  stored record, so "a tampered file is refused" holds for a same-size change.
