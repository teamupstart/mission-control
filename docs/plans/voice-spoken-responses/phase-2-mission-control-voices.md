# Speech 2: Mission Control voices

Part of `docs/plans/voice-spoken-responses/phased-plan.md`. Source plan: `plan.md` beside this
file. "Phase n" is a phase of the voice plan. Owns the better voice on macOS and Linux.

## 1. Outcome

The daemon can turn a short sentence into audio with Supertonic 3, in a helper process, on macOS
and Linux. The model is downloaded on request, pinned and verified. A Linux CI test proves
synthesis.

## 2. Entry criteria

Phase 8, Phase 16 and Speech 1 are merged. May run beside Speech 3.

## 3. Scope and non-goals

In scope: contract M, the speech model manifest entry, its download through Phase 8's manager,
the synthesizer helper and its supervision, the real `VoiceSynthesizer`, attribution, the CI
test, docs and tests.

Not in scope: playing audio (Speech 3 and the Linux follow-on), the picker and the download row
(Speech 4), any other model family.

## 4. Repository findings and inherited contracts

- Phase 8's manifest accepts only a Hugging Face URL pinned to a 40-character commit, a size and
  a SHA-256 per file, and its manager hashes each file again before reporting `ready`
  (contract H). Read Phase 8 as merged before extending it; this plan saw it unmerged.
- Phase 16 adds `sherpa-onnx-node` as a dependency, copies the platform's prebuilt addon into
  `dist/native/sherpa-onnx/` through `publishNativeAddon`, and adds one dedicated Linux CI job
  with a cached model. The operator authorized extending that job for this phase on 2026-11-23.
  No other CI, release or signing configuration changes.
- Measured for the plan with `sherpa-onnx-node` 2.0.3: the speech classes are in the same addon
  as the recognizer; Supertonic 3 int8 loads in about 0.3 seconds, synthesizes "Steve or
  Stephen?" in about 250 milliseconds, and holds 516 to 539 MB while loaded.
- The model is `csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11` at commit
  `cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4`, 145.3 MB in the seven files listed under "Model
  files" below. Its weights are under OpenRAIL-M (`Supertone/supertonic-3`) and its code is MIT.
- The ten voices: model indexes 0 to 4 are F1 to F5 and 5 to 9 are M1 to M5.
- Inherited: contract L from Speech 1, contract H from Phase 8.

Model files, measured for the plan on 2026-11-23. Verify each digest again when writing the
manifest.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `duration_predictor.int8.onnx` | 3700147 | `c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db` |
| `text_encoder.int8.onnx` | 36416150 | `c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff` |
| `vector_estimator.int8.onnx` | 78400833 | `20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd` |
| `vocoder.int8.onnx` | 25991073 | `e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152` |
| `tts.json` | 8253 | `42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09` |
| `unicode_indexer.bin` | 262144 | `8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30` |
| `voice.bin` | 517168 | `67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8` |

## 5. Implementation steps

1. **Manifest.** `VOICE_SPEECH_MODELS` with the `supertonic-3` entry: the files above, the
   source repository, the commit and the licence. `VOICE_SPEECH_NEURAL_VOICES`: the ten voices
   with id, name and model index. The pinning test Phase 8 wrote covers the new entry.
2. **Download.** Drive the speech model through Phase 8's manager as a second model set, stored
   under `<state home>/voice/models/speech/<revision>/`, with its own `VoiceModelState` in
   `VoiceState.speech.model`. Routes `POST` and `DELETE /api/voice/speech/model/download`.
   Nothing starts a download except that route.
3. **Helper.** `src/voice-speaker/synth.ts`, bundled to `dist/voice-speaker/synth.mjs`: a Node
   program that loads the addon from `dist/native/sherpa-onnx/`, loads the model directory it is
   given, and answers `synthesize { text, voice }` messages from its parent with 16-bit mono WAV
   bytes and the exact length. It reads no network, writes no file and logs no text.
4. **Supervision.** A daemon-side `NeuralSynthesizer` implementing `VoiceSynthesizer`: start the
   helper as a child on the first `synthesize` or `warm`, restart it once on a crash, stop it
   after 10 minutes without work and on daemon shutdown, and fail a request that takes more than
   5 seconds. Keep the audio of the 32 most recent (text, voice) pairs in memory.
5. **Warm-up.** Call `warm()` when a card enters `resolving` while `whenUnsure` is `ask` and the
   resolved voice is neural, so the model is loaded before the question is needed.
6. **Catalog.** Fill `catalog.neural` with the ten voices while the model is `ready`, and none
   otherwise, so `resolveSpeechVoice` starts choosing the Mission Control voice.
7. **Attribution.** The model, its source and the OpenRAIL-M licence with a link to its use
   restrictions, in `NOTICE` and `docs/voice.md`.
8. **CI test.** `test/voice-speech-synth.test.ts`: load the addon and the pinned model, start
   the helper, synthesize "Steve or Stephen?" with `VOICE_SPEECH_DEFAULT_NEURAL`, and assert a
   valid WAV whose length is between 0.5 and 4 seconds and is not silence. Extend Phase 16's
   dedicated job to restore this model from the same cache, keyed by its digests, and to run
   this test. In that job it has no skip. Elsewhere it runs when the model is cached and skips
   with the reason otherwise. Update the runner policy note in `ci.yml`.
9. **Docs.** `docs/voice.md` (the voice, where it is stored, memory while loaded),
   `docs/storage.md` (the new directory and its size).

## 6. Data and compatibility

Files under `<state home>/voice/models/speech/`, outside SQLite and settings backups. A new
model revision downloads beside the old one, as Phase 8 defines. With no model the neural
catalog is empty and nothing changes for a system voice.

## 7. Tests and verification

- `test/voice-models.test.ts`: the new entry's shape and pinning.
- `test/voice-speech-model-download.test.ts` against the fixture server Phase 8 uses: success,
  a digest mismatch, cancel, and verification at start.
- `test/voice-synthesizer.test.ts` with a fake helper: lazy start, one restart, the idle exit,
  the 5 second failure, the cache, and shutdown.
- `test/voice-speech-synth.test.ts`, the Linux proof, as step 8 describes.
- Manual check on a Mac, recorded in the pull request: download through the route, then fetch a
  job's audio and play the file by hand.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the tests.

## 8. Merge and exit criteria

A verified model is on disk after the download route. The helper synthesizes on macOS, and on
Linux in the dedicated CI job, which has passed on the pull request. No unit shard downloads a
model. The helper is gone 10 minutes after its last request.

## 9. Downstream handoff

Speech 4 draws the download row from `VoiceState.speech.model` and the routes here, and lists
`VOICE_SPEECH_NEURAL_VOICES`. The Linux follow-on reuses the helper unchanged.

## 10. Cross-phase audit record

- The download budget is 150 MB. The entry is 145.3 MB. A second family needs a new decision.
- If the addon does not load in the signed app, Phase 16 owns the fix, and this phase does not
  start until that phase has merged.
- The CI change is the one the operator authorized on 2026-11-23, and no other.
