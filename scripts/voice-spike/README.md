# Voice spike probes

Throwaway, opt-in tools. No application imports, build hooks, packaging changes or root
runtime dependencies. Run from the repository root. Outputs, models, audio and logs live
under the already ignored `.tmp/voice-spike/`. Do not commit them.

## Offline validation

```sh
node scripts/voice-spike/run.mjs --dry
npm run typecheck
npm run lint
```

The dry check works without macOS, models, network or audio hardware. It checks the
60-case routing corpus, JavaScript syntax and timestamp grouping arithmetic, not native
capabilities. Python probes require Python 3.11+; FluidAudio requires Swift 6.2+ here.

## File recognition

```sh
python3 scripts/voice-spike/download.py
python3 scripts/voice-spike/bootstrap-fluid.py
npm install --prefix .tmp/voice-spike/node --cache .tmp/voice-spike/npm-cache sherpa-onnx-node@2.0.3
python3 scripts/voice-spike/corpus.py
swift build --package-path scripts/voice-spike/fluid --scratch-path .tmp/voice-spike/fluid-local-build -c release
/usr/bin/time -l .tmp/voice-spike/fluid-local-build/release/Probe .tmp/voice-spike/fluid .tmp/voice-spike/audio/corpus.json > .tmp/voice-spike/fluid-results.jsonl 2> .tmp/voice-spike/fluid-runtime.log
/usr/bin/time -l .tmp/voice-spike/fluid-local-build/release/Probe .tmp/voice-spike/fluid .tmp/voice-spike/audio/corpus.json .tmp/voice-spike/ctc > .tmp/voice-spike/fluid-boosted-results.jsonl 2> .tmp/voice-spike/fluid-boosted-runtime.log
node scripts/voice-spike/sherpa.mjs > .tmp/voice-spike/sherpa-results.jsonl
node scripts/voice-spike/sherpa.mjs --hotwords > .tmp/voice-spike/sherpa-hotwords-results.jsonl
node scripts/voice-spike/sherpa.mjs --small --fixture
node scripts/voice-spike/sherpa.mjs --small > .tmp/voice-spike/small-results.jsonl
node scripts/voice-spike/summarize.mjs
```

Run timing commands sequentially after the builds finish. Concurrent compilation skews
latency. FluidAudio can print a CoreML diagnostic before its first JSON record; retain
that output and extract from the first `{` when summarizing. The download probe verifies
sizes and LFS digests, then records actual per-file SHA-256 in `model-manifest.json`.
The bootstrap replaces a stalled SwiftPM URL download with the identical verified local
xcframework. It changes only ignored vendor package manifests, not library source.

The corpus uses Samantha at 180 words/minute. It strips outer samples below amplitude 100,
inserts exact 16 kHz PCM silence, and pads name clips to 2, 4 and 6 seconds. Padding is
included in latency; these are not 6 seconds of continuous speech. Three repetitions of
a gap often have identical waveform hashes; they measure repeatability, not speaker diversity.
The roster is invented. The routing corpus never contains real session data. `sherpa.mjs`
uses two CPU threads; hotwords uses tokenized names and modified beam search.

## Operator checks

```sh
node scripts/voice-spike/mac-checks.mjs
```

The script prompts for four permission combinations, denial, hotkey presses/releases and
an unmuted/muted/ended call. Each app has a distinct bundle identifier. `S` is the parent
shell entitlement, `H` the helper entitlement. Both executables have hardened runtime.
The helper counts frames for three seconds and does not save audio. Logs include child
exit status. No permission state is reset; denial is a manual change for the probe only.
Do not rebuild while a probe app is running. Do not infer prompt attribution from Terminal.
Use `--build-only` to compile and verify signatures without opening apps.

```sh
.tmp/voice-spike/mac-probe devices
.tmp/voice-spike/mac-probe calls
.tmp/voice-spike/mac-probe calls 12345
```

The last command marks PID 12345 as our listener; it still prints it with `ignored:true`
so exclusion is reviewable. Call detection polls 60 times at 500 ms; `pollMs` includes
CoreAudio reads, not sleep or JSON output. Device records distinguish `bltn`, `blue`,
`blea` and USB by transport, after requiring an input stream. No input is captured.

## Focused Mac follow-up

```sh
node scripts/voice-spike/mac-followup.mjs
node scripts/voice-spike/summarize-mac.mjs
# Or select a retained run explicitly:
node scripts/voice-spike/summarize-mac.mjs .tmp/voice-spike/followup-YYYYMMDDHHMMSSmmm
```

Run this after the first operator checks. It preserves their logs and signed apps and
creates a timestamped `followup-*` result directory. Two fresh hardened apps exercise
explicit Don't Allow and Allow without resetting any existing permission. The script
validates the actual authorization value rather than treating a filename as denial.
It displays physical hotkey events live, labels call snapshots after Enter at each
state, and checks exclusion of a real capturing helper. The revised CoreAudio observer
skips/counts only per-process `kAudioHardwareBadObjectError`, retaining other failures.

For S9 select speakers, keep the room quiet, and provide output/volume/microphone details.
The automatic comparison speaks “Will, check the build. Steve, run the tests.” three
times each with capture running, stopped until speech ends, and stopped until 250 ms
after speech ends. Every trial includes two seconds after playback. Samples stay in
memory and pass through an anonymous pipe to the pinned local FluidAudio recognizer;
only transcript/metric logs persist. Rebuild the FluidAudio probe first if its source
changed. This check makes no external model request. `--build-only` compiles and verifies
signatures without opening apps or touching audio.

```sh
xcrun swiftc -module-cache-path .tmp/voice-spike/swift-cache scripts/voice-spike/mac.swift -o .tmp/voice-spike/mac-followup-probe
.tmp/voice-spike/mac-followup-probe hotkey-selftest
SPIKE_POLLS=8 SPIKE_STAGE=idle-followup .tmp/voice-spike/mac-followup-probe calls
```

The one-second self-test queues internal Carbon events to verify application-event
dispatch. It does not simulate physical keys or prove release/permission behavior.
The first probe used RunLoop without application dispatch; the old-loop reproduction
is a scratch copy replacing `app.run()` with
`RunLoop.current.run(until: Date(timeIntervalSinceNow: 1))`. It delivered no queued
press/release events, while the corrected loop delivered both. Never use this self-test
as a substitute for the operator's physical holds/releases.

## Routing (provider usage approved for this spike)

```sh
node scripts/voice-spike/routing.mjs haiku
node scripts/voice-spike/routing.mjs luna
node scripts/voice-spike/routing.mjs haiku --policy
node scripts/voice-spike/routing.mjs luna --policy
node scripts/voice-spike/summarize-routing.mjs
node scripts/voice-spike/stream.mjs
```

These use configured CLI authentication and incur provider usage. The routing probe sends
one synthetic case per fresh process, with tools disabled and thinking off; malformed output counts as a failed case and the probe continues. A nonzero process exit
stops the run. `--policy` adds explicit name-over-role precedence and a provider-enforced
response schema; baseline runs preserve the initial short prompt. Category labels and
expected answers are never sent to the provider (an open-card context is sent only for
option replies). Output appends, so preserve or rename an earlier log
before a distinct measurement. `SPIKE_LIMIT=1` limits a smoke run. The stream probe delays
its first question by two seconds, then sends a second turn after the first result to
measure prestart latency and reproduce or falsify the prior “Prompt is too long” report. Set
`SPIKE_PRESTART_MS=0 SPIKE_TURNS=1` for a cold one-shot, or
`SPIKE_PRESTART_MS=2000 SPIKE_TURNS=1` for its prestarted counterpart.
The clean two-turn run succeeded; it does not explain the missing historical reproduction. No decision-provider key was present
at initial inspection; no OpenAI Decisions or Jev request was made.

Capture-package compatibility was also probed with `naudiodon@2.3.6` in the isolated
Node prefix, an explicit `node-gyp rebuild` in its package directory, then
`node scripts/voice-spike/capture.mjs`. Enumeration crashes with exit 139 on this host.
That command does not start a microphone stream. Its native build warning reports no
arm64 slice in the bundled PortAudio dylib. Do not adopt it as a proven capture package.

## Phase 4 Haiku retest

`routing-retest.ts` measures the `voice-routing` job rung as the daemon runs it, through
`runVoiceRoutingJob` (prompt, system prompt, strict schema, thinking off, tools disabled, one
attempt, the configured Claude transport). It spends usage through your own `claude` login, so it
refuses to run without `--yes`; daemon modules are imported under a throwaway state home.

```sh
node --import tsx scripts/voice-spike/routing-retest.ts --yes --cases scripts/voice-spike/routing-tuning.json --label tune1-sdk
node --import tsx scripts/voice-spike/routing-retest.ts --yes --cases scripts/voice-spike/routing-holdout.json --label holdout-claude
node --import tsx scripts/voice-spike/routing-retest.ts --summarize holdout-claude
```

`--runner codex` runs Luna instead, `--transport print` measures `claude -p`, and `--start` and
`--limit` select cases. Results append to `.tmp/voice-spike/retest-<label>.jsonl`.
Each row records the SHA-256 digests of the corpus file and the prompts and response schemas
generated for that corpus. Use a fresh label when either digest changes or the old rows lack it.
`routing-tuning.json` is the spike's corpus recast as Phase 4's questions and is the tuning set;
`routing-holdout.json` was written before tuning and is the only pass evidence. The results are
in `docs/voice-spike-findings.md`, "S7 addendum: Haiku retest".

## Adopted first-word policy

The operator removed the pause requirement: an exact first-word name establishes the
initial target even with no pause. Run `node scripts/voice-spike/first-word.mjs` after
file recognition to replay this rule against the saved transcripts. It uses the synthesis
recipe as expected labels and no timing fields. “Will you grab the door” now intentionally
targets Will. `run.mjs --dry` covers later mentions and near-prefix names as well.
This is a throwaway replay, not app code or proof of live delivery. Preserve the timing
measurements for later refinement, but do not carry their old release gate forward.
