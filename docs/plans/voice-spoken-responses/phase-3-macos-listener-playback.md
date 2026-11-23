# Speech 3: the macOS listener plays

Part of `docs/plans/voice-spoken-responses/phased-plan.md`. Source plan: `plan.md` beside this
file. "Phase n" is a phase of the voice plan. Owns playback on macOS, the system voices, the
hotkey stop and the leak check.

## 1. Outcome

On a Mac, the listener speaks the question: it stops capture, plays the daemon's audio or speaks
with a system voice, reports when it started and ended, and restarts capture only once playback
has really stopped. It confirms every stop the daemon asks for. A tap of the mute hotkey cuts
the speech off. The shell names each helper process, tells the daemon when it has started and
when it has exited, and replaces one that does not confirm. Ask aloud does not hear
itself.

## 2. Entry criteria

Phases 10 and 11 and Speech 1 are merged. May run beside Speech 2.

## 3. Scope and non-goals

In scope: the Swift helper's speech side, its hello's `speech` part, the shell's hotkey rule,
the shell's naming of each helper process, its exit report and its replacement of a helper that
does not confirm a stop, the same in the development launcher, the leak check, docs and tests.

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
  `speech` part, the stop route), all built by Speech 1.

## 5. Implementation steps

1. **Speak an audio job.** The helper names its instance, from
   `MISSION_VOICE_LISTENER_INSTANCE`, in the `x-mission-voice-instance` header on every
   directive poll, audio fetch and report, as contract L's job ownership requires, and puts it
   in no URL and no log line; the daemon tells only the holder about a job. When the
   directive's `speak` is an audio job: stop audio input,
   fetch the WAV from the audio route with the token, play it with `AVAudioPlayerNode`, post
   `started` when playback begins, and post `ended` as `finished` from the completion callback
   that fires when the audio has played out, not when it was scheduled.
2. **Speak a system job.** When `speak` is a system job: stop audio input and speak the text
   with `AVSpeechSynthesizer` and the named voice, posting `started` and `ended` from its
   delegate. Keep the synthesizer alive until it finishes. An unknown voice id is `ended` as
   `failed`.
3. **Stop and failure.** When `speak` is `{ id, stop: true }`: stop whatever is playing,
   whichever job it is, do not start a job that has not started, and post `ended` as `stopped`
   for the named id once the player has actually stopped. Post that `ended` also for an id the
   helper never received, because the daemon waits for it and reads it as proof that the
   helper is silent; if a different job was playing, post that job's `ended` as well. After a daemon restart the daemon recovers the job from
   its record and the helper's directive names the stop request for the job it holds, so the
   helper stops and posts `ended` on this same path. When `speak` becomes null or names
   another job mid-speech, which only a lost record could cause, stop playback the same way
   and post `ended` for the job it held. A fetch error, a playback error or an
   output device change that halts playback is `ended` as `failed`. Every job the helper was
   given, and every stop request, gets exactly one `ended`.
4. **Resume.** The helper opens the microphone only when it is not playing and holds no job it
   has not ended, whatever the directive's `capture` says. After `ended`, restart audio input
   only if `capture` is true, as a fresh recognition segment. Replay nothing buffered before
   the pause.
5. **Hello.** Send `speech { audio: true, systemVoices, instance }` with the installed English
   voices, each with its identifier, name, language and quality tier, and the instance id from
   `MISSION_VOICE_LISTENER_INSTANCE`, which the process that started the helper chose. The
   helper exits when the process that started it goes away, so it does not outlive its
   supervisor.
6. **Leak check.** With the real helper on a Mac, loudspeakers and the built-in or a desk
   microphone: three trials with capture forced to stay on during an audio job, then three with
   the normal pause, then the same six with a system voice. Record what the recognizer heard in
   each. The audio job uses the Mission Control voice when Speech 2 has merged; otherwise run
   the helper against a test daemon whose synthesizer serves a recorded WAV through Speech 1's
   audio route. If a paused trial is heard, add a 250 millisecond delay before resuming and
   repeat. If
   it is still heard, the helper sends `audio: false` and lists no system voices, so
   `speech-output` stays unavailable; tell the operator and record the finding in
   `docs/voice.md`.
7. **Hotkey.** In the shell's tap handler from Phase 11: when the voice state shows a live
   speech job, a tap calls `POST /api/voice/speech/stop` and does not toggle mute. Otherwise
   it toggles mute as before.
8. **Name, report and replace.** In the shell's listener supervisor from Phase 10, following
   contract L's supervised instances. Before each start: choose a new instance id, post
   `started`, write the id to the supervisor record that section 6 defines, pass the id in
   `MISSION_VOICE_LISTENER_INSTANCE`, and add the process id and the process's start time to
   the record as soon as the child has started. On the child's exit event, and on nothing
   earlier, post `exited` for that id, and remove the record once the daemon has accepted it.
   An `exited` the daemon did not accept, because it was down, is kept and repeated when the
   shell reconnects. A signal sent to the child, a timeout waiting for it, and the start of
   a new child are not an exit and post nothing. When the voice state's `listener` capability
   carries the daemon's "did not confirm that speech had stopped" condition: stop the helper,
   escalate to a kill if it does not exit, wait for the exit event, post `exited`, and only then
   start the next helper under a new id. One replacement per condition, with the supervisor's
   usual backoff. At shell start, read the record an earlier run left. If its process is still
   alive: check by the start time that the process id still belongs to the helper, stop it, and
   wait until that process no longer exists. If its process is already gone, there is nothing
   to stop. Either way post `exited` for the recorded id before starting a new helper. A record
   that has an id and no process id, left by a run that ended in the instant between starting
   the helper and recording it, is reported as exited only once the operating system lists no
   process running the helper executable. A record that cannot be read is treated the same
   way, and is removed, after that proof, before `started` is posted for a new helper, because
   the daemon may be waiting on it. Read the other supervisor's record too: report and
   remove it when its process is gone, and leave it alone while its process is alive. Repeat
   `started` for the running helper whenever the shell reconnects to a restarted daemon. The
   development launcher from Phase 9 does the same for the helper it starts, under its own
   record.
9. **Docs.** `docs/voice.md` (system voices, how to install a better one, the leak check's
   result, what happens when a listener does not confirm), `docs/desktop-and-packaging.md`,
   `docs/storage.md` (the listener record under the state home).

## 6. Data and compatibility

One file is stored per supervisor, by the supervisor and never by the daemon:
`<state home>/voice/supervised/<supervisor>.json`, where `<supervisor>` is `shell` for the
desktop shell and `dev` for the development launcher. It holds one record, for the helper that
supervisor most recently started: `{ instance, pid, startedAt }`. `startedAt` is the process's
start time as the operating system reports it, which tells the helper from another program
that was later given the same process id.

- Who may read it. The directory is created owner-only (0700) and the file owner-only (0600),
  written by write-then-rename, because the instance id in it is the secret contract L
  describes. Supervisors read it at their start. The daemon reads it in one case only, when
  its own `speech-holds.json` cannot be read (contract L, restart recovery), and never writes
  it. It appears in no log.
- Lifetime. Written with the id before the helper is started, and completed with the process
  id and start time as soon as the helper has started. Kept while the helper runs and after it
  exits until the daemon has accepted `exited` for that id, then removed. The next start
  writes a new record only after that.
- What it is not. It is machine-local runtime state: not in the database, not part of a config
  export, and not restored with one. Deleting it while a helper it names is running loses the
  supervisor's way to report that helper's exit, so nothing but the supervisor removes it.

The daemon's record of unresolved speech jobs, `speech-holds.json`, is Speech 1's. A helper
built before this phase sends no `speech` part and the daemon reads it as unable to play. The
protocol's major version does not change.

## 7. Tests and verification

- Swift tests on macOS with a stub player and a stub synthesizer: the order stop, play, report,
  resume; the instance id is in the header of every poll, fetch and report and in no request
  URL; one `ended` on each path; a stop
  mid-speech, where `ended` is posted only after the
  stub player reports it has stopped; a stop before playback started, which never starts it; a
  stop for an unknown id, which is still answered; a stop request naming another id than the
  job being played, which stops the player and posts `ended` for the named id only after the
  stub player reports it has stopped; a stop request for the held job arriving on
  the first poll after a reconnect, as after a daemon restart, which stops playback and posts
  one `ended`; no resume while `capture` is false; no
  microphone while the stub player is still playing, even with `capture` true.
- `test/voice-listener-supervisor.test.ts` gains cases with a fake child process: `started` is
  posted before the child starts and carries the id the child receives; `exited` is posted from
  the exit event and not when the stop signal is sent; a child that ignores the stop signal is
  killed and `exited` is still posted only after its exit event; the next child is not started
  until the previous one's exit has been reported; the "did not confirm" condition replaces the
  helper once; a recorded helper from an earlier run is stopped and reported before a new one
  starts, and a recorded process id that now belongs to another program is not signalled;
  the record is written owner-only with the id before the child starts, gains the process id
  and start time once it has started, and is removed only after the daemon accepts `exited`;
  an `exited` posted while the daemon is down is repeated on reconnect and the record is kept
  until then; a recorded helper whose process is already gone is reported at start; a record
  with no process id is not reported while a helper process is listed and is reported once
  none is; an unreadable record is removed only once no helper process is listed, and before
  `started` is posted for a new helper; the other supervisor's record is reported and removed
  when its process is gone and left alone while it is alive.
- `test/voice-listener-protocol.test.ts` gains cases for `speak` against the fake listener.
- `test/voice-hotkey-tap.test.ts`: a tap stops speech while a job is live and toggles mute
  otherwise, as a pure function of the voice state.
- Manual check, recorded in the pull request: the leak check's twelve trials with what was
  heard; ask aloud with a system voice asks once and a spoken name picks; a hotkey tap stops it;
  unplugging headphones mid-speech returns capture.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:electron` and the
  tests.

## 8. Merge and exit criteria

On a Mac with a system voice chosen, an unsure card is asked aloud once, capture is off until
playback has really stopped, including after a stop or an expired limit, and the recognizer did
not hear the question in any paused trial. If the
leak check fails after the added delay, the phase merges with playback reported unavailable and
says so. The helper still builds on macOS arm64 and is skipped cleanly elsewhere.

## 9. Downstream handoff

Speech 4 lists the system voices this phase reports. The Linux follow-on implements steps 1, 3
and 4, and the `audio` flag and instance id of step 5, in the sherpa-onnx listener, and the
announcement, exit report, record and replacement of step 8 in whatever supervises the
listener on Linux, including the proof a restarted daemon needs when it is that supervisor.

## 10. Cross-phase audit record

- The audit note in Phase 12 about S9 moves here, and is stricter: a leak that pausing cannot
  stop leaves Ask aloud unavailable, where Phase 12 said off by default.
- Plan validation round 5: the daemon may read the supervisor record, in the one case where
  its own record of unfinished speech cannot be read, to learn which helpers could be playing.
  A stop request now stops whatever is playing, so its `ended` proves silence. Steps 3 and 8,
  section 6 and the tests changed.
- Plan validation round 4: section 6 said nothing was stored while step 8 stored the
  supervisor's record. Section 6 now defines the record, its permissions and its lifetime, and
  step 8 names it. The same round made the daemon keep unresolved jobs across a restart, so
  step 3 no longer expects a restarted daemon to clear `speak`, and the shell repeats an exit
  report the daemon was not up to accept.
- Pull request review: the helper sends its instance in a header, not in a URL, so the id
  does not reach a request log. Step 1 and its test changed.
- Plan validation round 3: the helper names its instance on every request, which is how the
  daemon gives a job to one helper and accepts reports only from it.
- Plan validation round 2: a new helper saying hello no longer releases capture. The shell
  proves the old helper has stopped by reporting its exit from the exit event, and starts the
  next helper only after that. Step 8, its tests and the hello's instance id changed.
- Plan validation round 1: the helper confirms every stop and never opens the microphone while
  it is playing, and the shell replaces a helper that does not confirm, so capture cannot
  return while playback continues after a limit.
- The audio route is Speech 1's, so this phase does not wait for Speech 2. With Speech 2
  unmerged no neural voice is ready, so an audio job arrives only in tests, where Speech 1's
  audio route serves a WAV from a fake synthesizer.
