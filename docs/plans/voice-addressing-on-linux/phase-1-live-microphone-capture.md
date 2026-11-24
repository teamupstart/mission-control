# Phase 1: Live microphone capture

The approved source is `docs/plans/voice-addressing-on-linux/plan.md`. Read the implementation index `phased-plan.md` beside this file. Repository scope is mission-control.

## Outcome

An operator can launch the sherpa listener on the test desktop, speak a roster name and message, and see the daemon accept the timed utterance. This supplies the live input for daemon supervision.

## Entry and direct dependencies

Planning publication, the operator’s explicit confirmation of a reserved physical desktop and tester, and the merged task “Voice Addressing for Agents - Phase 16: The sherpa-onnx backend”. Record access before any spike or implementation. Identify audio stack, session, input/output devices and test architecture.

## Scope

Own capture selection, the live mode of the standalone listener and evidence for device closure. Leave daemon startup, desktop reports, spoken playback and Setup rendering to later phases. Keep file-input mode confined to its current development/test use.

## Implementation and compatibility

Compare an installed PipeWire or PulseAudio client against a directly integrated audio library on the operator’s desktop. Measure dependency availability, device enumeration and stable IDs, default and selected input, format conversion to mono 16 kHz, capture timestamps, startup/stop latency, reliable device release, hotplug and recovery. Include CPU/backpressure under recognition. Select the smallest candidate that can prove all required boundaries. Document required packages and diagnostics for the tested stack. If none qualifies, record the failed measurements and return the choice to the operator before adoption.

In the merged Phase 16 build script and launcher, trace actual model selection, token file and loopback validation. Extend the no-file entry in src/voice-listener/sherpa.ts with a live source. Preserve file recognition coverage including revision invalidation and bounded VAD scanning. Put live hardware lifecycle beside the listener and share decoder/hotword/word merge. Keep device and sample-clock information available to the desktop observer without persisting raw audio.

Keep device probes separate from recording. Report actual permission and device readings, including unknown, denied and selected input lost. Establish readiness without recording while muted. With an authorized current directive, stream bounded in-memory PCM through VAD, roster hotwords, decoding and word timings. Close the input and invalidate stale PCM and decoder work on mute, mode/revision changes, poll failure or lease loss. A wedged decoder must not delay closing the microphone. Apply the existing explicit held-release exception only to audio proven inside that physical key interval. Preserve the deployed protocol major, lease ID, revision, heartbeat and monotonic capture/start/onset/end headers as required by the merged routes. The file helper’s JSON-only directive reader needs access to release/draining headers for live input. Clip and decode again at key-up when required. Discard uncertain audio. Pass only utterances and timing metadata to the daemon. Keep raw samples, recognized text and tokens out of listener logs.

While capture is enabled, arm a listener-local monotonic deadline on each accepted directive, using the current lease lifetime (30 seconds with the existing 25-second server long poll). Only a fresh authorized directive can renew capture. A hello heartbeat, queued decode or pending poll cannot extend the deadline. On expiry, close the physical input, discard buffered audio and retire the poll generation independently of request completion. Ignore all callbacks from retired generations. Reacquire only after a new poll under a valid lease explicitly authorizes capture.

Qualify the capture client’s process lifetime as part of backend selection. If capture runs out of process, abruptly kill the listener while the client owns a real input stream. Verify through OS process and audio-server observations that the client exits and releases the microphone. A backend qualifies in Phase 1 only if the standalone entry point independently cleans up after abrupt listener death, including a crash during helper launch. Implement and test that lifetime tie in this phase or reject the candidate. The standalone listener must never depend on a future daemon supervisor to release its microphone. Document the identity and ownership mechanism with the backend choice.

## Verification and merge criteria

Run `node --test --import ./test/setup-state.mjs --import tsx test/voice-listener-protocol.test.ts test/voice-word-merge.test.ts test/voice-utterances-http.test.ts` and new live-source tests with injected PCM, delayed decoding and revoked directives. Hold a directive request pending with the input open and keep hello heartbeats succeeding. Advance the clock through expiry and assert the input closes while the request is still pending. Deliver its late capture-enabled response and assert the device stays closed and stale samples never reach the daemon. A subsequent fresh authorized poll may reopen it. Repeat on the physical device with a stalled poll and observe closure from the audio server. Exercise the existing model-backed Linux recognizer job. On hardware test first use, selected device loss, physical mute close/reopen, and a phrase cut by mute. Confirm OS capture state independently. Document candidate measurements, no raw recordings, and the chosen backend in docs/voice.md. No passing candidate means this phase stays open.

Run the repository typecheck and lint. Run build and smoke for runtime changes, the applicable unit suite, and browser E2E for visible changes. Use Node 24 or newer and the test-state preload. Keep hardware results and screenshots in PR/workflow evidence. Record measured limitations in the technical guide. Merge when the outcome works through the stated entry point and its failure cases pass.

## Downstream handoff and cross-phase audit

Later phases may start the live program without a WAV, select the verified model and identify the running input stream. Capture follows revision-aware directives; an independent reporter may observe the device without becoming its owner. No new persisted setting or wire route is required.
