# Phase 4: Spoken playback

The approved source is `docs/plans/voice-addressing-on-linux/plan.md`. Read the implementation index `phased-plan.md` beside this file. Repository scope is mission-control.

## Outcome

A supervised Linux listener plays an ask or audition and the tester hears it. Capture stops before output and can resume after verified silence, including when a stop interrupts a fetch, playback or device change.

## Entry and direct dependencies

Planning publication, Linux 2, “Spoken Responses for Voice - Speech 1: The speech job and ask aloud” and “Spoken Responses for Voice - Speech 2: Mission Control voices”. All three are direct merge prerequisites. Use the operator-arranged physical microphone and speakers.

## Scope

Implement only the Linux listener side of L and physical S9 qualification. Consume the upstream speech manager, synthesizer and model. No new engine, provider, picker, browser audio or speech setting.

## Implementation and compatibility

Any implementation phase adding Linux playback has two **direct merge prerequisites**: “Spoken Responses for Voice - Speech 1: The speech job and ask aloud” and “Spoken Responses for Voice - Speech 2: Mission Control voices”. It also requires proven Linux capture stop/restart and the supervised-instance lifecycle. Contract L supersedes the addressing plan’s shell-owned speech capability and macOS-only ask path. Reuse M’s daemon-started synthesizer, on-request Supertonic 3 download (about 150 MB), Automatic F4, existing picker, and daemon-computed speech-output. Linux lists no system voices. The on-screen card is the fallback. The only Linux speech work is playback, supervision/recovery and truthful Setup reporting.

Extend the merged src/voice-listener/client.ts per its token, lease and loopback rules. Use the supervisor instance on each speech request. Integrate a cancellable device player beside sherpa.ts; keep the finite recording feeder’s semantics intact. Serialize capture closure, async audio fetch, start, drain, cancel, event reporting and reacquisition. Make repeated directives and failed requests idempotent. Reuse the daemon’s existing durable stopping state on disconnect.

**Show that the listener is silent.** Announce a supervised instance first. A live hello advertises speech.audio only when a working, qualified player is available. For each holder-specific audio directive, stop and await physical capture closure, discard pending acoustic input, fetch the in-memory WAV from the existing token route, then play on the default output. Name the holder in x-mission-voice-instance on directive polls, audio fetches and event reports. Keep the existing listener lease header separately. Send started at actual playback start and ended after output drains or a stop really silences the device. Keep polling during fetch/playback. Serialize cancellation, stale callbacks, duplicate directives and event retries. Every stop silences whatever is playing, cancels pending starts and returns ended/stopped for the named job, including unknown or already-ended IDs. Output loss ends as failed after silence is certain. While playing, stopping or awaiting resolution keep local capture closed even if a directive is stale. Resume only under a fresh capture directive and an otherwise eligible mode. An external player must have a provable lifetime tied to the listener; qualify an in-process player preferentially so its audio cannot outlive process-exit proof.

## Verification and merge criteria

Run `node --test --import ./test/setup-state.mjs --import tsx test/voice-listener-protocol.test.ts test/voice-listener-lifecycle.test.ts` plus new player and upstream Speech 1/2 contract tests. Use a controllable player that withholds drain to prove capture stays closed. Exercise mismatched holders, unknown stop, duplicate directives/events, cancellation during fetch, player failure, output removal and shutdown. Repeat with the real player in a disposable Linux fixture. Conduct three open-control and three paused S9 trials: tester hears the reply, no recognized/routed self-speech with capture paused, and subsequent human speech works. If paused trials leak, test the upstream 250 ms delay; with persistent leakage withhold audio readiness and report the failed qualification. Record output device, stack and results.

**Required hardware crash trial.** On the reserved Linux desktop, start a reply long enough for the tester to hear it through the speakers. While it is still audible, abruptly terminate only the daemon and restart it against the same state home. Observe physical output independently of the listener and timestamp the microphone stream closing and reopening on the same timeline. Record the recovered holder’s stop confirmation or OS-proven exit, and any replacement listener’s first capture. Pass only if capture stays closed across restart until both the speakers are silent and the holder is cleared. If a replacement starts, its predecessor must already have exited. Verify that none of the reply is routed and that a fresh spoken message is delivered afterward. An inconclusive timeline leaves this hardware gate open.

Run the repository typecheck and lint. Run build and smoke for runtime changes, the applicable unit suite, and browser E2E for visible changes. Use Node 24 or newer and the test-state preload. Keep hardware results and screenshots in PR/workflow evidence. Record measured limitations in the technical guide. Merge when the outcome works through the stated entry point and its failure cases pass.

## Downstream handoff and cross-phase audit

Linux 5 consumes Speech 1’s daemon-computed speech-output and reason plus actual listener audio readiness. Linux 4 consumes no Linux 3 adapter. A physical proof and an OS-backed stop are required even when waveform generation succeeded in CI.
