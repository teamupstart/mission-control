# Voice spike findings

Status: **COMPLETE for the scoped spike and ready for workflow handoff.**
First-word addressing is approved; pause timing no longer blocks it.
Measured 2026-11-23 on Apple M4 Pro, 48 GiB RAM, macOS 26.6.2 (25G83), arm64,
Node 26.7.0, Swift 6.4. No product code, application imports or packaging changes.

**Adopted operator decision: when the first word matches an agent's name, route to that
agent without requiring a pause.** Pause discrimination is deferred and no longer an
S1/S3 release gate. Both backends correctly identify the initial name in all 57 recorded
synthetic clips under this rule (including 30 roster trials). This is offline replay, not
an end-to-end delivery test. The operator completed both native Mac runs. The measured
Option chord, hardened permission path, Zoom input detection and paused-capture speech
suppression are usable starting points. Linux, other call apps, physical Bluetooth/built-in
inputs and human-speaker accuracy remain outside these measurements.

| Question | Verdict and chosen starting point |
| --- | --- |
| S1 FluidAudio | GO for file transcription and first-word names: 30/30 roster names, 57/57 initial-target replay; warm p50/p95 41.6/47.5 ms. |
| S2 sherpa | GO for file inference/hotwords; NO-GO for naudiodon 2.3.6 capture on this Mac (SIGSEGV). Pin the measured 110M TDT fixture. |
| S3 Addressing | GO with the operator-approved first-word rule; no `pauseMs` prerequisite. |
| S4 Permission | GO: parent audio-input entitlement; explicit denial reaches helper as status 2, grant false, exit 2. |
| S5 Hotkey | GO for Control+Command+Option+V: 3 presses and 3 releases, no permission prompt. Non-Option behavior is unproven. |
| S6 Other microphone use | GO for the CoreAudio process-input signal, including muted Zoom and own-helper exclusion; start with 500 ms polling. |
| S7 Model step | GO for bounded Luna feasibility at confidence 0.98 and 5 s total deadline; NO-GO for the tested Haiku general-routing prompt. Phase 4's Haiku retest: no wrong answer and 90% accepted on a held-out set, but one call of 60 missed the deadline, so the rung ships off ([addendum](#s7-addendum-haiku-retest)). |
| S8 Devices | GO for transport metadata classification; one USB input observed, zero built-in/Bluetooth fixtures. |
| S9 Speech output | GO for stopping capture through playback completion: 3/3 listening trials leaked speech; 0/6 paused trials did. |

## Inputs and reproducibility

At the spike's initial checkout, `plan.md`, `phased-plan.md` and `phase-0-spike.md` matched the SHA-256 entries
of managed plan `deccc636-b913-4507-b2cc-17f89d5b6581`, revision 6, in the local store.
No same-name replacement or later revision was used. The operator's later first-word
instruction explicitly supersedes the pause requirement in V5 and its downstream phase
interpretation. The pinned plan files remain unchanged; the adopted deviation is recorded
here for reviewers and implementers. The task explicitly starts on the planning PR stack
despite the phase's original merged-plan entry criterion.

After planning PR #1653 merged, the operator requested a base update to remove inherited
plan content from the task diff. The spike branch was rebased onto `main` at
`f829c38943738543e8cf80d6fe60a93116d4593e`, preserving all findings and probes. The original
three input files remain captured in the ignored measurement workspace; the measurements
still refer to revision 6, not the newer plan text now present on `main`.

Commands and prerequisites are in [the probe README](../scripts/voice-spike/README.md).
All measurements below are directly observed unless marked pending or inferred. Models,
recordings and raw logs are ignored under `.tmp/voice-spike/`. The generated, byte-verified
[model manifest](../scripts/voice-spike/models.json) contains every downloaded file's
repository, exact commit, byte size and SHA-256, including the CTC vocabulary model and
110M recognizer fixture. It is reproducibility input, not app configuration.

`python3 scripts/voice-spike/corpus.py` produced 57 clips: ten invented names at three
lengths, eight inserted gaps repeated three times, and three continuous controls. Names:
Steve, Will, Luna, Atlas, Nova, Jordan, Quinn, Sage, Phoenix, Rowan. Voice: Samantha at
180 words/minute; mono 16 kHz signed 16-bit PCM. Outer samples below amplitude 100 are
trimmed before exact sample-count silence is inserted. Name clips are padded to 2/4/6
seconds; these lengths include trailing silence, not 6 seconds of spoken content. Three
gap repetitions frequently have identical hashes, so they are repeatability checks, not
independent speakers. No real microphone audio enters these recognition trials.

Timing is wall time per file after model initialization, not microphone-to-delivery latency.
Percentiles use nearest rank. Final main-backend runs were sequential after compilation;
earlier contended timings were discarded. This is a single-host synthetic feasibility
sample, not an accuracy estimate for accents, noise, far-field audio or production load.

## S1: FluidAudio

**GO for first-word name recognition, file transcription and roster-rescoring feasibility
on this Mac.** Chosen pause policy: bypass pause checking. Token-timing limitations remain
measured below but no longer gate this approved behavior. Live microphone behavior remains
subject to S4 and the later listener tests.

Library source: `FluidInference/FluidAudio` at
`eb280cede001a9a35f2187d4a117537777eca756`. Parakeet v2 CoreML repository:
`FluidInference/parakeet-tdt-0.6b-v2-coreml` at
`ee09c569f73759e6d44c9bd16766f477b2b36d39`. Exact required components are Encoder,
Decoder, JointDecision, Preprocessor and parakeet_vocab.json; older similarly named
components in that repository are deliberately excluded.

Commands: the two `/usr/bin/time -l .../Probe ...` commands in the probe README. Both
plain and primed runs recognized all 30/30 name trials. Priming uses
`VocabularyBoostingSession` with ten `CustomVocabularyTerm`s, the separate
`FluidInference/parakeet-ctc-110m-coreml` model at
`accdafd8cf8a2ff1cabe3c11e54416b405d409aa`, and rescoring the same 16 kHz samples.
It is not an initial-prompt string on the TDT decoder. The clean corpus gives no measured
accuracy benefit from priming; a noise/confusable-name corpus is still needed.

Warm OS-cache readiness was 221.0 ms plain and 340.8 ms with CTC. The first observed cold CoreML
load took 22,494 ms, including a CoreML shape-inference diagnostic; all 57 files then
completed. That first-run output was not retained separately; registered runtime logs
cover the later warm runs. Subsequent loads still print that diagnostic but succeed. Do not turn the
warm number into a first-install readiness budget. Maximum resident set from `time -l`
was 89,440,256 bytes plain and 107,380,736 bytes boosted in the final warm runs; the first
cold run was 525,844,480 bytes. OS/CoreML caches and accelerator allocations make these
process figures unsuitable as a complete device-memory budget.

| Backend | Cases | Names | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| fluid | 57 | 30/30 | 41.6 | 47.5 |
| fluid-boosted | 57 | 30/30 | 54.0 | 66.7 |
| sherpa | 57 | 30/30 | 78.7 | 214.5 |
| sherpa-hotwords | 57 | 30/30 | 94.7 | 264.5 |

Per-length timings (10 clips per cell; p50 / p95 milliseconds):

| Backend | 2 s | 4 s | 6 s |
| --- | ---: | ---: | ---: |
| fluid | 40.6 / 73.8 | 42.5 / 44.1 | 45.7 / 47.5 |
| fluid-boosted | 54.3 / 76.5 | 57.6 / 60.9 | 61.8 / 68.4 |
| sherpa | 79.3 / 92.6 | 143.6 / 155.6 | 213.3 / 235.1 |
| sherpa-hotwords | 97.4 / 116.1 | 174.3 / 249.8 | 254.6 / 272.6 |

## S2: sherpa-onnx

**GO for macOS file inference and hotwords. NO-GO for the tested naudiodon capture
package on this host. Linux and live capture remain unverified.** Chosen library:
`sherpa-onnx-node@2.0.3`, CPU provider, two threads, `nemo_transducer` model type.
Model: `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` at
`84b478d541cdbf0c296a7ab5f1e20a6f8f998114`.

Commands: `node scripts/voice-spike/sherpa.mjs` and the same with `--hotwords`.
Both recognized 30/30 names. Hotwords use tokenized roster names passed to `createStream`
and `modified_beam_search`; plain inference uses `greedy_search`. Initialization took
880.8 / 763.4 ms respectively. Maximum sampled process RSS was 2,040,889,344 /
2,044,837,888 bytes. Sampling is after each file, so transient peaks may be higher.
The node addon emits token starts and durations, but its `words` array is empty here.
The summary explicitly groups word-boundary tokens rather than pretending words exist.

Capture probe: `naudiodon@2.3.6` installed in isolated scratch storage; its explicit
`node-gyp rebuild` completed with a warning that bundled PortAudio lacks arm64. Running
`node scripts/voice-spike/capture.mjs` loaded sherpa successfully, then crashed in
naudiodon's `getDevices` with SIGSEGV, exit 139. It failed both inside and outside the
sandbox. No recording was started. This rules out this exact package/build combination;
it does not establish that every PortAudio binding fails. Do not use this package as
Phase 16's proven microphone implementation.

Fixture choice: `csukuangfj/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000` at
`e9bea5a06247dc3f55319ff23d34b0328f2f5ddf`, fp32 encoder/decoder/joiner and tokens.txt.
This is smaller in parameter count and follows the same offline NeMo TDT path. It is
477,648,555 bytes including the provided 237,964-byte `test_wavs/0.wav` fixture, so it
is not a tiny CI download. `node scripts/voice-spike/sherpa.mjs --small` completed all 57
synthetic clips and recognized 28/30 names. Its role is addon/model/protocol compatibility,
not production accuracy. The similarly named int8 repository at
`09886b8f4a07e83aff44046d3398675881d77601` contains only `.gitattributes`; do not pin it.
A 27.6 MB Zipformer alternative exists but takes a different decoder path. Prefer the
110M model for coverage; cache its pinned bytes in Phase 16. No Linux machine was used.

## S3: first-word addressing; pause refinement deferred

**GO for the approved first-word rule. Pause detection is not a blocker.** The operator
explicitly prioritized routing to the agent whose name is the first word over avoiding
the pause edge case. This replaces the earlier decision to keep the timing gate blocked.
No acoustic detector or forced-alignment extension is required in this spike.

Downstream behavior for phases 3 and 9:

- An unambiguous exact name in the first word establishes the initial target, independent
  of word timings, a missing timing array, or the task's similarity to an agent's role.
  Apply ordinary case and boundary-punctuation normalization. Do not prefix-match Will
  against Willow or William. Phonetic matching and multiword call signs remain governed
  by their own existing requirements; this probe covers the ten single-word names.
- Both “Will, grab the door” and “Will you grab the door” target Will. Ordinary speech
  that begins with that name can therefore be routed; the operator accepts this tradeoff.
  A later mention alone, such as “Please ask Will,” does not establish Will as the target.
- No model call is needed to choose the target of an exact initial-name match, and a model
  must not replace it merely because another agent's role seems more appropriate. Separate
  split/mention and card-answer requirements still apply where relevant.
- Bypass the pause predicate rather than setting `pauseMs` to zero: zero would still
  depend on timestamps existing and would reject overlapping boundaries. No measured
  pause default is supplied. Keep the existing preview and cancellation requirements.

Command: `node scripts/voice-spike/first-word.mjs`. This throwaway replay selects a target
from the actual saved transcripts without reading their timings. Expected names come from
the synthesis recipe, not from the recognized text. Each main backend and priming variant
matches 57/57: 30/30 ten-name roster trials, 24/24 gap trials, and 3/3 continuous “Will you”
controls. The latter are intentional routes under the new policy, not false positives.
`run.mjs --dry` also checks later-name mentions, near-prefix names, punctuation and case.
The application router has not been implemented or exercised here. This establishes
synthetic recognition/replay feasibility, not noisy real-world or end-to-end reliability.

The timing measurements are retained for later refinement. **NO-GO only for the retired
250 ms timing-only rule**, not for the newly approved first-word behavior:

Command: `node scripts/voice-spike/summarize.mjs`. Gap is next word start minus preceding
word end, using FluidAudio's word grouping or sherpa token starts plus durations. The
following are first repetitions of each condition (the other two agree here):

| Inserted gap, ms | FluidAudio observed gap, ms | sherpa greedy, ms | sherpa hotwords, ms |
| ---: | ---: | ---: | ---: |
| 0 | 240 | 160 | 160 |
| 100 | 160 | 160 | 160 |
| 150 | 0 | 160 | 80 |
| 200 | 160 | 160 | 160 |
| 250 | 160 | 160 | 160 |
| 300 | 0 | 160 | 160 |
| 400 | 320 | 240 | 240 |
| 500 | 320 | 320 | 320 |
| continuous control | 0 | 0 | 0 |

FluidAudio's 250 ms name-plus-"check the build" clips can have zero gap when punctuation
is grouped into the name. The separate "Will, grab the door" clips yield the values above.
A 250 ms cutoff misses all three 250 ms "Will" trials in both backends. A 160 ms cutoff
admits the zero-inserted-gap condition as well. Even the tempting 250 ms separation from
"Will you grab the door" is not robust to the other tested utterances. Token duration and
punctuation timing are not an acoustic silence meter. This measured overlap, rather than
an inferred internal cause, is the basis for the historical timing-only no-go. It was
raised to the operator and discussed through Mission Control. The subsequent explicit
first-word decision resolves that gate without claiming the timing issue has been fixed.

## S4: hardened microphone permission

**GO for parent entitlement, prompt attribution and explicit denial on this hardened
ad hoc path.** Command: `node scripts/voice-spike/mac-checks.mjs`. The operator
completed the first run. All four apps passed `codesign --verify --deep --strict`; both
executables have hardened runtime and every bundle declares NSMicrophoneUsageDescription.
Each parent launches a separately signed helper. `S` denotes the parent entitlement and
`H` the helper entitlement; 1 means `com.apple.security.device.audio-input` is present.

| App | Prompt observed | Authorization before / after | Grant | Frames in 3 s |
| --- | --- | --- | --- | ---: |
| S0H0 | None | 0 / 0 | false | 0, helper exit 2 |
| S0H1 | None | 0 / 0 | false | 0, helper exit 2 |
| S1H0 | Name included S1H0 | 0 / 3 | true | 139,200 |
| S1H1 | “VoiceSpike-S1H1” would like to access the Microphone. | 0 / 3 | true | 139,200 |

The granted captures used 48 kHz input, with peaks 0.04868 and 0.05004 respectively.
No audio was saved. The parent entitlement was necessary in these four trials; the
helper entitlement alone was insufficient, and parent-only succeeded. Chosen minimum
for this launch topology: parent audio-input entitlement plus usage description. This
does not establish a separately launched helper's requirements. Phase 10 must confirm
its final Developer ID build and actual launch topology.

The file named `permission-denied.log` still reports authorization 3, grant true and
139,200 frames. It is **not denial evidence**. The helper's no-grant exit 2 is observed
for missing-parent-entitlement variants, not yet for an explicit user denial. The focused
`node scripts/voice-spike/mac-followup.mjs` uses a fresh Deny bundle, requests Don't Allow,
and checks for authorization 2 and grant false. No existing app permission is reset.
The follow-up observed authorization **0 to 2**, grant **false**, and **helper exit 2**,
with no capture frames. The operator confirms clicking Deny; the exact follow-up prompt
name was not recorded. Prompt attribution therefore rests on the first run's recorded
names. The separate fresh Allow app changed **0 to 3**, grant true, and captured
**139,200 frames at 48 kHz**, peak 0.03356, helper exit 0. This proves the intended
allow/deny distinction without conflating absent entitlements with user denial.

Final native run: `.tmp/voice-spike/followup-20261123145610034`. Reproduce its summaries
with `node scripts/voice-spike/summarize-mac.mjs .tmp/voice-spike/followup-20261123145610034`.
All subsequent native tables use that same run; raw logs and notes are registered as
workflow evidence and remain outside Git.

## S5: hotkey press and release

**GO for Control+Command+Option+V with press and release and no permission prompt.**
The non-Option chord is **not proven**, so it is not the recommended default.
The original run installed its handler and registered both Control+Command+V and
Control+Command+Option+V with status 0, but logged zero press or release events. The
operator's note was empty, so it does not prove absence of a permission prompt either.
Registration success alone was insufficient to choose a chord.

The original `RunLoop.current.run` serviced sources without dispatching queued application
events. A one-second internal-event reproduction queued one Carbon press and release:
the old loop delivered neither; the corrected `NSApplication.run` loop delivered both,
with all create/parameter/queue/handler statuses 0. This verifies the loop repair, not
physical key delivery or permission behavior. Commands:

```sh
.tmp/voice-spike/mac-old-loop hotkey-selftest
.tmp/voice-spike/mac-followup-probe hotkey-selftest
```

The old-loop binary was built from a scratch copy of `mac.swift` replacing `app.run()`
with the original RunLoop call, bounded to one second. `hotkey-selftest` posts only
internal Carbon events, never system keystrokes. The follow-up displays actual events
live and requests three two-second holds per chord, one Option-first release, and notes
about permission prompts or sticky keys. The completed physical run returned:

| Chord | Registration status | Presses | Releases | Matched hold durations |
| --- | ---: | ---: | ---: | --- |
| Control+Command+V | 0 | 0 | 0 | None |
| Control+Command+Option+V | 0 | 3 | 3 | 2,022 / 2,736 / 2,159 ms |

All three Option press/release pairs matched, with handler status 0 and no unmatched
events. Operator note: “no permission prompt. all 3 worked”. Choose the Option chord
for downstream implementation. The log does not distinguish whether the non-Option
chord was attempted or unavailable, nor annotate which release was Option-first. Do not
claim either a macOS failure for the non-Option chord or a separately verified modifier
release-order guarantee. The selected Option chord has the physical key-up evidence
needed for this spike; alternate chords still need their own check.

## S6: another app on the microphone

**GO for the CoreAudio running-input signal, including muted Zoom and own-helper
exclusion.** The original idle command `.tmp/voice-spike/mac-probe calls` completed
60 polls at 500 ms, with no active input processes: median query 5.878 ms, maximum
127.739 ms (first poll). These are wall times, not CPU utilization percentages.

The operator used Zoom 7.1.9 (88375). Of 59 successful polls, 42 reported
`us.zoom.xos` using input, beginning at 14:39:10 UTC; the list first became empty at
14:39:31 UTC. Median query was 13.239 ms, maximum 54.757 ms. The final poll failed
with CoreAudio 560947818 (`!obj`, `kAudioHardwareBadObjectError`). Exact mute/leave
times were not recorded, so the transition cannot establish what Zoom does while muted.

The probe reads `kAudioHardwarePropertyProcessObjectList`, then PID, bundle id and
`kAudioProcessPropertyIsRunningInput`. A process object can disappear between list and
property reads. The revised probe counts/skips only that specific per-object error;
other errors still fail visibly. An eight-poll idle follow-up completed without errors
or stale objects. It does not reproduce the exit race or validate the mute policy.

The focused follow-up took separate eight-poll snapshots after the operator confirmed
each state. Zoom was again 7.1.9 (88375); the operator reported normal behavior.

| State | Zoom active polls | Own helper ignored | Other active polls after exclusion | Query median / maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Unmuted call | 8/8 | 0/8 | 8/8 | 7.047 / 56.401 |
| Muted call | 8/8 | 0/8 | 8/8 | 5.783 / 58.363 |
| Left call | 0/8 | 0/8 | 0/8 | 7.920 / 63.851 |
| Own capturing helper only | 0/8 | 7/8 | 0/8 | 6.412 / 68.054 |

The own-helper trial's first poll preceded its capture; all seven subsequent polls
identified its supplied PID with `ignored:true`. That helper captured 384,000 frames
at 48 kHz over eight seconds. There were no errors or stale objects in these 32 polls;
the process-exit race was not reproduced in this final run.

Chosen starting interval: **500 ms**. Treat any non-ignored running-input process as
microphone contention and retain suspension while Zoom is muted: its Mute control does
not release input in this test. This is an input-use signal, not a general call-status
API. Poll timing is measured query cost, not end-to-end transition latency. Other call
apps, reconnects and suspended sessions still need integration coverage.

## S7: routing model

**GO for bounded Luna routing feasibility with validation and abstention. NO-GO for the
tested Haiku general-routing prompt.** This is a small synthetic experiment, not a
production accuracy or confidence-calibration guarantee. It tests target/option choice
and split-versus-mention intent, not verbatim message segmentation or end-to-end delivery.

The operator explicitly approved the invented corpus and provider usage after the initial
automatic-approval rejection. The 60 unique cases in `routing-cases.json` are balanced
12 each across plain names, phonetic names, split commands, mentions and loose option
answers. Expected choices and category labels are not sent to either provider. Option
replies get an open-card context; other inputs are plain utterances. Each run uses one
fresh process per case from `/private/tmp` with tools disabled and no repository access.

Models: `claude-haiku-4-5` through Claude Code 2.1.319, and `gpt-6-luna` through Codex
0.166.0. Luna follows the repository's current cheap-model choice rather than the older
`gpt-5.6-luna` cited in the plan. Haiku is configured with thinking disabled and reports
zero thinking tokens in the recorded response envelopes. Luna is requested with
`model_reasoning_effort="none"`; the exec output does not expose a comparable thinking-token
count. Providers ran concurrently with each other, one case at a time per provider. These
wall times include CLI startup and network variation, not isolated model compute.

Two passes on the same set (120 calls per backend, no held-out set):

- Baseline: a short routing prompt and JSON-only instruction. Haiku's extra prose made
  48 answers unusable by the strict JSON parser; malformed output counts as failure,
  not as a guessed extraction. The original runner stopped after the first malformed
  answer; the remaining 58 cases were resumed once, without rerunning the first two.
- Policy + schema: explicitly preserve the spoken name even if the requested work seems
  better suited to another role, preserve a mention as a mention, and enforce the same
  response-object schema through each CLI. This is not an isolated prompt-vs-schema
  ablation: both changes were applied together. Haiku reads `structured_output` on this
  path. The output schema alone does not restrict values to the roster/card choices;
  membership validation is also required before delivery.

Commands (all completed 60 unique cases):

```sh
node scripts/voice-spike/routing.mjs haiku
# After the recorded formatting failure on case 2:
SPIKE_START=2 node scripts/voice-spike/routing.mjs haiku
node scripts/voice-spike/routing.mjs luna
node scripts/voice-spike/routing.mjs haiku --policy
node scripts/voice-spike/routing.mjs luna --policy
node scripts/voice-spike/summarize-routing.mjs
```

| Backend/pass | Valid JSON | Usable exact choices | p50 wall ms | p95 wall ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| haiku / baseline | 12/60 | 10/60 | 2093 | 3130 | 4379 |
| haiku / policy + schema | 60/60 | 48/60 | 1795 | 3260 | 4379 |
| luna / baseline | 60/60 | 52/60 | 2976 | 4345 | 6070 |
| luna / policy + schema | 60/60 | 59/60 | 3161 | 4180 | 9749 |

Policy + schema correctness by category (each out of 12):

| Backend | Plain | Phonetic | Split | Mention | Card option |
| --- | ---: | ---: | ---: | ---: | ---: |
| haiku | 11 | 10 | 11 | 7 | 9 |
| luna | 12 | 12 | 12 | 12 | 11 |

Haiku policy API duration was p50 928 ms / p95 2,329 ms, versus wall 1,795 / 3,260 ms.
It still redirected “Jordan, check the build” to Steve at confidence 0.95 and converted
several “ask [name]” mentions into split commands at 0.95. One answer gave the nonexistent
option “neither of these” confidence 1.0. A confidence threshold without membership
validation is therefore unsafe even at 1.0. At 0.95 plus membership validation, Haiku
would accept 53 cases with 8 wrong choices. At 0.98 it accepts only 7/60, all correct in
this sample, leaving 53 abstentions. That is too little coverage to endorse this as the
general Claude-session routing rung. Do not silently substitute Luna for Claude sessions;
Phase 4 must respect this no-go or obtain a deliberate provider/prompt change and retest.

Luna's only wrong exact answer was a safe “not sure” for “keep it in a file” (expected
SQLite). The two deliberate uncertainty cases also returned “not sure.” At 0.98 plus
membership validation, 56/60 would be accepted with zero wrong choices, with 4 abstentions.
At 0.99 coverage drops to 50/60 without improving the observed error count. This does not
calibrate confidence on unseen speech, names, roles or cards; the threshold is selected
in-sample and needs a held-out corpus before a broader reliability claim.

**Recommended provisional values for the Luna rung:** confidence floor **0.98**, mandatory
schema and allowed-choice validation, and a **5,000 ms total model-stage deadline**.
The full deadline includes process start and any earlier rung; fallback must use only the
remaining budget. Expiry or “not sure” produces the existing ambiguity path, never a late
send. Two Luna cases took longer than five seconds (5,055 and 9,749 ms), so this deadline
would accept 54/60 with zero wrong deliveries and abstain on 6, including those two
otherwise-correct answers. That is an explicit responsiveness/coverage tradeoff, not an
assertion that all calls finish in five seconds. The probe's 30-second kill timer is a
measurement watchdog, not the proposed product timeout. Haiku's policy calls all finished
within five seconds; its blocker is accuracy, not the deadline.

### Prestart and the earlier stream failure

Commands: `node scripts/voice-spike/stream.mjs` for two turns, then three runs each of
`SPIKE_PRESTART_MS=0 SPIKE_TURNS=1 node scripts/voice-spike/stream.mjs` and
`SPIKE_PRESTART_MS=2000 SPIKE_TURNS=1 node scripts/voice-spike/stream.mjs`.
The one-shot comparison asks the same trivial “Say alpha” question, not a full routing
schema. It isolates whether starting the CLI in advance can hide startup work.

| Process mode | n | Question-to-answer median | Spawn-to-answer median |
| --- | ---: | ---: | ---: |
| Start with question | 3 | 897 ms | 903 ms |
| Start 2 s before question | 3 | 473 ms | 2,475 ms |

All six one-shot trials succeeded. Prestart removed about 424 ms from median perceived
response time in this sample by spending startup time earlier. It did not eliminate the
model request or reduce total process lifetime. Do not apply the 473 ms figure to complex
routing: that workload's schema-enforced one-shot median is 1,795 ms for Haiku.

The separate two-turn run answered “alpha” in 455 ms after submission and “beta” in
961 ms, exiting 0. Input-token counts were 478 and 516. No “Prompt is too long” failure
occurred. This is a counterexample to a general claim that `claude -p` streams cannot
accept a second question, not a root-cause explanation of the historical failure. Its
original prompt, CLI version and failure envelope are absent; the cause remains
unestablished. Avoid carrying the prior failure forward as proof that reuse is impossible.
The second result's API-duration field is cumulative (1,377 ms versus first-turn 425 ms),
so use independently measured submit-to-result time for per-turn latency. For the planned
stateless request, prefer a fresh process started ahead for one question; indefinite
conversation reuse was not benchmarked or proposed.

Neither OPENAI_API_KEY nor TYPESAFE_API_KEY was present at inspection. Decisions/Jev
trials are skipped as the phase allows when a key is absent; no provider-specific timeout
or accuracy claim is made for them.

### S7 addendum: Haiku retest

Measured 2026-11-23 in Phase 4 on the same Mac, Claude Code 2.1.319. **The improved prompt
passed on accuracy and coverage and missed the deadline, so the Claude-session Haiku rung ships
off.** The operator ruled that it ships enabled only if a retest passes, and that the bar is not
lowered to make it pass. Luna for Codex sessions is unchanged from S7 and was not retested.

**What changed from the spike's prompt.** The model is no longer asked to route against the whole
roster. Phase 4 asks only narrow questions: `split` (the first target is fixed; does a later name
start a message of its own, or is it only mentioned), `who` (a first name in doubt, judged by
sound, never by role) and `option` (a loose answer to a card). An exact first-word name is never
asked about. Each answer is an enum of that question's choices plus "not sure" in a strict JSON
schema the provider enforces, and the daemon checks membership again before reading confidence.
The prompt, system prompt and schema are `src/server/voice/decide-prompt.ts`.

**How it was run.** `scripts/voice-spike/routing-retest.ts` calls `runVoiceRoutingJob`, the
function the daemon calls: `claude-haiku-4-5` through the Agent SDK transport (the daemon's
default), thinking disabled, `tools: []`, `settingSources: []`, the strict schema and one
attempt, one fresh process per case, one case at a time, under a throwaway state home. Wall
time is measured around the whole call, process start included. Expected answers and category
labels are never sent. This used the operator's own `claude` login.

**Tuning set.** The spike's 60 cases recast as these questions (`routing-tuning.json`). No wrong
answer was accepted at any floor from 0.5 to 0.99; at 0.9, 56 of 60 were accepted. Wall time
p50 3,412 ms, p95 4,094 ms, maximum 5,077 ms (one call over five seconds). The tuning set is not
pass evidence.

**Held-out set.** 60 new cases (`routing-holdout.json`): a new invented roster of twelve names,
new sentences and three new cards, 12 per category, 4 of them cases where "not sure" is the right
answer (2 phonetic, 2 option). Written before any tuning run, never used to tune, and run once
after the prompt and the floor were frozen.

**Floor: 0.9**, chosen on the tuning set before the held-out run. No wrong answer was accepted
there at any floor, so the floor is not what held errors at zero; 0.9 sits below the band of
Haiku's confident answers (0.95 to 0.99) and excludes its hesitant ones (0.85 and below), which
on the tuning set were the near-miss names.

| Floor | Accepted | Wrong accepted | Abstained |
| ---: | ---: | ---: | ---: |
| 0.5 | 56 | 0 | 4 |
| 0.8 | 56 | 0 | 4 |
| **0.9** | **54** | **0** | **6** |
| 0.95 | 53 | 0 | 7 |
| 0.98 | 27 | 0 | 33 |
| 0.99 | 15 | 0 | 45 |

At 0.9, per category (each of 12):

| Category | Accepted | Wrong | Abstained | p50 wall ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Plain names | 12 | 0 | 0 | 3,608 | 4,244 |
| Phonetic names | 8 | 0 | 4 (2 expected "not sure", 2 right at 0.85) | 3,715 | 8,930 |
| Split commands | 12 | 0 | 0 | 3,388 | 4,084 |
| Mentions | 12 | 0 | 0 | 3,536 | 4,381 |
| Loose card options | 10 | 0 | 2 (both expected "not sure") | 2,703 | 3,311 |

The table counts confidence and membership before applying the clock. With the runtime deadline,
53 of 60 (88.3%) would have been accepted, including 7 of 12 phonetic names. The other four
categories keep the counts shown above. Overall wall time p50 3,533 ms, p95 4,381 ms, maximum
8,930 ms.

| Bar (Voice Feature PM's default) | Result |
| --- | --- |
| Zero wrong accepted answers at the floor shipped | **Met**: 0 of 54 |
| At least 80% of cases accepted | **Met**: 54 of 60, 90% |
| Every call inside the 5,000 ms model-stage deadline | **Missed**: 59 of 60; `phonetic-04` took 8,930 ms (correct, 0.95) |

None of the spike's three failure modes recurred: no plain name was redirected by role, no
mention became a split, and every answer was one of the question's choices. These figures are
in-sample on synthetic text from one host, not a confidence calibration. The first ten or so
calls overlapped unit tests run on the same machine; the slow call came after them, and the set
was not rerun to look for a passing sample.

**Why it is slow.** Through the Agent SDK, a schema-enforced reply takes two model turns: Haiku
answers, the CLI then has it call its structured-output tool. Probes of the same split question
took 2.3 to 3.2 seconds in two turns with the schema and about 1 second in one turn without it.
Telling the model to call the tool at once did not save the turn. `claude -p` with the schema and
settings isolated also took two turns, 3.4 to 4.1 seconds. Possible next steps, not taken here
because each changes what the operator specified or needs a new held-out corpus: drop the
provider schema for Claude and rely on the daemon's strict parse and membership check, or keep a
process started ahead of time.

**The "Prompt is too long" failure, explained.** The spike could not reproduce it. On this Mac a
plain `claude -p` loads the operator's user settings, and a two-word prompt went out as about
294,865 tokens, over Haiku's 200,000-token limit, and failed with "Prompt is too long". The same
call with `--strict-mcp-config` or `--setting-sources ""` sent 1,295 input tokens and answered.
The daemon's default SDK transport passes `settingSources: []` and is not affected; the `print`
transport is, for every background job, and is left as it is in this phase.

Commands:

```sh
node --import tsx scripts/voice-spike/routing-retest.ts --yes --cases scripts/voice-spike/routing-tuning.json --label tune1-sdk
node --import tsx scripts/voice-spike/routing-retest.ts --yes --cases scripts/voice-spike/routing-holdout.json --label holdout-claude
node --import tsx scripts/voice-spike/routing-retest.ts --summarize holdout-claude
```

## S8: input devices

**GO for transport-metadata classification. Physical built-in/Bluetooth validation was
not available on this host.**
Command: `.tmp/voice-spike/mac-probe devices`. This host exposes one input stream on a
NexiGo HD Webcam Audio device, transport 1970496032 (`usb `). Zero built-in or Bluetooth
input devices were present. The probe filters on input streams and compares the CoreAudio
transport property to `bltn`, `blue` and `blea`; names are for display, not classification.
Select by device UID, prefer built-in only when present, then offer the available devices.
Bluetooth quality changes and reconnection behavior were not measured on this hardware.

## S9: system speech feedback

**GO for stopping capture through speech playback completion on the measured local
path; NO-GO for leaving capture active during system speech.** Command:
`node scripts/voice-spike/mac-followup.mjs`, summarized by `summarize-mac.mjs` as above.
The helper played Samantha at 180 words/minute saying “Will, check the build. Steve,
run the tests.” It captured mono 48 kHz input and sent samples through an anonymous pipe
to the pinned local FluidAudio recognizer. No microphone audio was saved or sent to a
provider. Each clip used fresh decoder state.

| Capture policy | Trials | Nonempty recognized speech | Measured restart after say exit | Captured frames per trial |
| --- | ---: | ---: | --- | ---: |
| Quiet baseline | 1 | 0/1 | Not applicable | 96,000 |
| Listening during speech | 3 | 3/3 | Already running | 312,000 |
| Stop through speech, no additional delay | 3 | 0/3 | 79.5 to 88.6 ms | 96,000 |
| Stop through speech, add 250 ms | 3 | 0/3 | 330.2 to 338.2 ms | 96,000 |

Playback lasted 3,999 to 4,400 ms. Listening trials included a 200 ms lead-in and two
seconds after playback; paused trials captured only two seconds after restart. Quiet
RMS was 0.002295; listening RMS ranged 0.006213 to 0.016419. Paused audio was not digital
silence (RMS 0.002453 to 0.014612), yet none of the six paused clips produced recognized
speech. This establishes suppression of recognized feedback, not absence of acoustic
energy or a false-positive rate for every room.

All three listening transcripts contained “check the bill” instead of “check the build”;
two preserved the initial Will and one omitted it. These acoustic samples are not the
clean 30/30 file-based roster benchmark. They demonstrate both feedback risk and the
limit of extrapolating synthesized-file accuracy to a physical audio path.

Chosen starting behavior: **stop capture before playback, wait for actual completion,
then restart with a fresh recognition segment; no additional fixed delay for this tested
AVAudioEngine/say path.** This is not a zero-millisecond effective gap: restarting the
engine already cost 79.5 to 88.6 ms. A faster capture implementation or a different speech
completion callback needs another tail-leakage check. The 250 ms alternative also passed
but added latency without an observed benefit in this sample. Do not replay buffered
pre-pause speech into the resumed segment.

The operator completed the speaker instructions but left output/volume/placement notes
blank. The earlier input enumeration identified a NexiGo USB webcam microphone; exact
output hardware, volume and placement for this run are unrecorded. Three trials per
policy on one setup establish feasibility, not a universal echo-control guarantee.

## Deviations and PR handoff

- The operator explicitly replaced V5's name-plus-pause prerequisite with first-word
  name addressing. Pause refinement is deferred; the measured timing defect no longer
  blocks phases 3/9. Preserve this adopted deviation in the PR description and downstream
  implementation handoff. The pinned plan revision is not silently rewritten.
- The task's explicit stacked start overrides the original merged-plan entry criterion.
- Warm and cold initialization are reported separately. Main latency runs were repeated
  sequentially after compilation to remove our own build contention.
- A separate pinned CTC model is included because FluidAudio priming requires it.
- SwiftPM's artifact download stalled. The bootstrap uses curl, verifies the exact
  upstream checksum, then substitutes a local xcframework path in ignored vendor
  manifests. It changes no vendor library source or product file.
- S7 adds a second prompt/schema pass because the initial JSON-only prompt produced
  formatting failures and role-over-name errors. All failures are retained, not discarded.
- The small recognizer uses 110M fp32 because its int8 repository is empty; using the
  same NeMo TDT decoder path is favored over the much smaller Zipformer alternative.
- The task's later initial-handoff instruction forbids committing, pushing or creating
  a PR in this turn. None was done. On the later authorized PR path, target
  `harness/voice-addressing-for-agents-phas-f69e9c` and start the body with
  `Stacked on #1653` linked to https://github.com/teamupstart/mission-control/pull/1653.
  Carry these deviations and the completed measurement evidence into that PR.
- The first Mac run exposed a hotkey dispatch flaw and a CoreAudio process-lifetime race
  in the throwaway probe. The focused follow-up preserves the original evidence, explicitly
  verifies denial, labels call states and adds the acoustic S9 comparison.
- S5 selects the physically demonstrated Option chord. The non-Option chord registered
  but has no physical events in either saved run; it is unproven, not declared broken.
- All nine questions now have a bounded verdict and chosen starting point. The spike
  does not authorize downstream code to ignore the capture-package or Haiku no-go, or
  generalize a single-host measurement to untested hardware/providers. No product code
  has been added. Completion hands control back to Mission Control for its workflow.

## Verification

`node scripts/voice-spike/run.mjs --dry`, `npm run typecheck` and `npm run lint` pass on
this Mac. Lint emits pre-existing repository warnings; the focused probe lint is checked
separately. The dry path performs no network, native imports or hardware access; it has
not been executed on Linux. The signed native probe builds and verifies. No build/smoke
or UI tests are necessary because no product runtime or UI surface changed.

## Primary reference sources

- [FluidAudio pinned vocabulary implementation and usage](https://github.com/FluidInference/FluidAudio/blob/eb280cede001a9a35f2187d4a117537777eca756/Documentation/ASR/CustomVocabulary.md)
- [sherpa NeMo models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html)
- [sherpa contextual biasing contract](https://k2-fsa.github.io/sherpa/onnx/hotwords/)
- Apple SDK CoreAudio `AudioHardware.h` / `AudioHardwareBase.h` and Carbon Event Manager
  declarations from the installed macOS SDK. Native probes, not documentation claims,
  determine the permission and hotkey verdicts.
