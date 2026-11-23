# Phase 0: spike

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns no requirement; it supplies measured values to phases 4, 8, 9, 10, 11, 12 and 16.

## 1. Outcome

`docs/voice-spike-findings.md` answers nine questions with numbers and a go or no-go each, and
`scripts/voice-spike/` holds the probes that produced them. No product behaviour changes.

## 2. Entry criteria

The planning pull request is merged. No phase dependency.

## 3. Scope and non-goals

In scope: throwaway probes, a test set of utterances, the findings document. Not in scope: product
code, packaging, anything the app loads. The probes are not built by `npm run build` and are not
listed in `electron-builder.yml`.

## 4. Repository findings

- Native addons are built by `scripts/build-native.mjs` and published by
  `scripts/native-addon-publish.mjs`; a probe addon may use `node-gyp` directly and stay local.
- The signed build's options are in `scripts/package-distribution.mjs:27-35`. A probe app can be
  signed ad hoc with the hardened runtime to test entitlements without release credentials.
- Background jobs start one `claude` process per call (`src/server/llm/claude-sdk.ts`). Measured on
  2026-11-22: Haiku answers in about 0.6 seconds with thinking off and a short system prompt,
  against 2.5 to 4.9 with the job defaults; process start adds 1.2 to 1.8. A second question sent
  to one running `claude -p` stream process failed with "Prompt is too long".

## 5. Questions to answer

Speech is generated with the macOS `say` command into audio files, with silences of known length,
so no person has to speak for S1 to S3.

1. **S1 FluidAudio.** Parakeet TDT 0.6B v2 CoreML: are word or token timings good enough to see a
   250 millisecond pause after a name? Latency on utterances of 2 to 6 seconds, memory, how names
   are primed and how often a roster of ten names is heard correctly. Record the Hugging Face
   repository, commit and per-file SHA-256.
2. **S2 sherpa-onnx.** The same measurements for the v2 int8 ONNX export with its Node addon and
   hotwords, on macOS and, where a Linux machine is at hand, Linux. Does a microphone capture
   package work beside it?
3. **S3 Pause threshold.** The gap that separates "Will, grab the door" from "Will you grab the
   door" for each backend. Recommend the default `pauseMs`.
4. **S4 Microphone permission.** In an ad hoc signed, hardened-runtime probe app that starts a
   helper binary: which executable needs `com.apple.security.device.audio-input`, which name the
   prompt shows, and what a denial looks like to the helper.
5. **S5 Hotkey.** A Carbon `RegisterEventHotKey` probe: press and release for chords with and
   without Option, with no permission prompt, on the current macOS.
6. **S6 Call detection.** A CoreAudio probe that lists processes with running input and ignores its
   own; polling cost; behaviour while a call app is muted.
7. **S7 Model step.** Latency and accuracy on a test set of 60 utterances (plain, phonetic,
   two-name split, two-name mention, loose card answers) for Haiku and Luna with thinking off, and
   for the OpenAI Decisions API and Jev when a key is present in the environment. Can a process
   started ahead of time and used for one question remove the start cost? Explain the "Prompt is
   too long" failure. Recommend the confidence threshold and time limits.
8. **S8 Input devices.** How to tell the built-in microphone from a Bluetooth one.
9. **S9 Speech output.** Does the listener hear the system voice while it speaks, and is pausing
   capture enough to prevent that?

S4, S5 and S6 need a person at the Mac for a few minutes. Ask the operator through
`request_input` with the exact command to run and what to report.

## 6. Data and compatibility

None. Nothing here is loaded by the app.

## 7. Tests and verification

`node scripts/voice-spike/run.mjs --dry` exits 0 on Linux and macOS without audio hardware. `npm
run typecheck` and `npm run lint` pass. The findings cite the commands that produced each number.

## 8. Merge and exit criteria

The findings document has a section per question with the measurement, the chosen value and go or
no-go. A no-go on S1, S4 or S5 is raised to the operator before this phase is called done.

## 9. Downstream handoff

Phase 4 reads S7. Phase 8 reads the pinned repositories and digests from S1 and S2. Phase 9 reads
S1, S3 and S8. Phase 10 reads S4. Phase 11 reads S5 and S6. Phase 12 reads S9. Phase 16 reads S2.

## 10. Cross-phase audit record

- Written first. Phases 4, 8, 9, 10, 11, 12 and 16 name the question they read and state what
  they do when its answer is no-go.
