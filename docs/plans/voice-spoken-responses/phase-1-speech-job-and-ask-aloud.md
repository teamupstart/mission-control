# Speech 1: the speech job and ask aloud

Part of `docs/plans/voice-spoken-responses/phased-plan.md`. Source plan: `plan.md` beside this
file. "Phase n" is a phase of `docs/plans/voice-addressing-for-agents/phased-plan.md`, the voice
plan. Owns the ask-aloud half of V14, the capture rule and stopping by a click.

## 1. Outcome

When routing is unsure and the operator chose Ask aloud, the daemon opens a speech job, tells the
listener to stop capture and speak, and returns capture only when the listener confirms that
playback has ended. A time limit or a stop asks the listener to stop; it never returns capture
by itself. The card shows that it is asking and can stop it. Everything is proven with
a fake listener that plays, so it runs on Linux CI with no audio.

## 2. Entry criteria

Phases 6 and 9 are merged. May run beside Phases 7, 8 and 10 to 16.

## 3. Scope and non-goals

In scope: contract L, the `speech` config field, the job and its limits, the capture rules, the
audio, events, stop and audition routes, the `speak` directive, the hello's `speech` part, the daemon-owned
`speech-output` capability, the asking mark and Stop on the card, the rule that enables the Ask
aloud choice, the fixture, docs and tests.

Not in scope: synthesizing audio (Speech 2), playing it (Speech 3), the picker (Speech 4), any
spoken sentence other than the ask.

## 4. Repository findings and inherited contracts

As of `f34b14043`, where Phase 1 has merged as #1671:

- `VoiceConfigSchema` reads tolerantly and `VoiceConfigPatchSchema` is strict
  (`src/shared/voice.ts`), so a new key needs a default and a patch entry, and no
  migration.
- `VoiceStateStore.state()` drops a shell's claim about `listener` and writes its own
  (`src/server/voice/state.ts:69-75`). `canonicalVoiceState` lists each state field by
  hand, so a new field has to be added there or a change to it is never published.
- The "When routing is unsure" row draws both choices with no condition
  (`src/web/components/VoiceSettingsPanel.tsx`).
- Token and dashboard voice routes are registered in `src/server/voice/routes.ts`.
- Inherited: the config and its routes (contract A); the state, the hello and `beListener`
  (contract B); `VoiceCard`, the `unsure` state, the utterance route and Recently heard
  (contract D); `VoiceCardView` (contract G); the directive route (contract I, Phase 9).

## 5. Implementation steps

1. **Contract.** `src/shared/voice-speech.ts` with everything contract L names. Add `speech` to
   `VoiceConfigSchema` with the default `{ voice: null }` and to the patch schema, merged per
   key. Amend the comment that says later phases add no field.
2. **Hello and state.** Add the optional `speech` part to the hello schema. Add
   `VoiceState.speech` and include it in `canonicalVoiceState` and `voiceStateOff`. Compute
   `speech-output` in the state store beside `listener`, with a reason for each way it is
   unavailable: no listener, a listener no supervisor has announced, a listener that cannot
   speak the voice, no voice ready.
3. **Speech manager.** `src/server/voice/speech.ts`: one live job at a time and a queue in
   opening order; `open(purpose, text, cardId)`; `stop(id)`; the events route's `started` and
   `ended`; a timer per job that expires at the start limit after it became `ready`, or, after
   `started`, at the audio length plus the end margin, or at the system limit when the length
   is unknown. An expired timer and a stop both move the job to `stopping`, as contract L's
   stop handshake defines: the job becomes final only on the `ended` of the instance that was
   given it, or on an exit report for that instance (step 8). A hello from a different instance
   changes nothing: the job stays as it is and the newcomer is given no job. A late `started`
   leaves the job `stopping`. With no `ended` by the confirm limit the manager tells the state
   store the listener is not answering, and the store treats it as absent until a late `ended`
   or the exit report. The manager records which instance holds each unresolved job, and that
   record survives muting and a voice off and on. A job
   whose card is settled while it is still `preparing` is dropped. Clocks and timers are
   injected, as in the state store.
4. **Voice and audio.** The manager resolves the voice with `resolveSpeechVoice`. For a neural
   voice it calls the `VoiceSynthesizer` and holds the audio in memory for the audio route until
   the job is final. A synthesizer that rejects ends the job as `failed`. This phase ships one
   that refuses, and an empty neural catalog, so only system voices can be spoken.
5. **Directive.** Extend Phase 9's directive: `speak` carries the ready job, or
   `{ id, stop: true }` while the job is `stopping`. `capture` is false while a job is `ready`,
   `speaking` or `stopping`, so it cannot return before the listener's `ended` or its exit
   report. The directive is the same for every listener that polls, so a second listener cannot
   capture while the first still holds a job. A change to either field ends the long poll.
6. **Utterance guard.** The utterance route ignores an utterance whose `capturedAt` falls
   between a job becoming `ready` and its becoming final, with the Recently heard reason
   `while-speaking`.
7. **Ask aloud.** When a card becomes `unsure`, `whenUnsure` is `ask`, the mode is `listening`
   and `speech-output` is available, open one `ask` job with `askSentence` of the candidates'
   names. A null sentence opens no job. A card gets at most one ask. Muting, a pick, a cancel
   and a settled card stop the job.
8. **Routes.** `POST /api/voice/speech/stop` stops the live job. `POST
   /api/voice/speech/audition` opens an `audition` job for the resolved voice with the first two
   roster names, or "Steve or Stephen?" when the roster has fewer than two, and answers 409 with
   the capability's reason when nothing can speak. `POST /voice/listener/supervised` (token)
   records an announced instance on `started` and, on `exited`, ends every job that instance
   holds as `failed`; an `exited` for an instance that holds nothing changes nothing. A speech
   job is given only to an announced instance. The two token routes of contract L: the
   events route, and the audio route, which serves the WAV the manager holds for a `ready` or
   `speaking` job and answers 404 for any other job.
9. **Card.** `VoiceCardView` marks an `unsure` card whose id is the `cardId` of a job that is
   `ready` or `speaking` with "Asking aloud" and a Stop button. The mark goes as soon as the job
   is `stopping`. A candidate row and Cancel work as before and also stop the
   speech.
10. **Setting.** In the "When routing is unsure" row the Ask aloud choice is disabled, with the
    capability's reason as its description, while `speech-output` is unavailable. A stored `ask`
    is kept and behaves as `show` until speech is available.
11. **Fixture.** `beSpeaker` in `e2e/fixtures/voice.ts`. Its hello says it can play, lists one
    system voice, so a voice resolves in this phase, where no neural voice exists, and carries
    an instance id. It also plays the supervisor: it announces its instance before its first
    hello and can report that instance's exit. It answers a stop request with `ended`, as a
    listener must. It has options to delay `started`, to keep playing past the limit until told
    to end, to ignore a stop request altogether, and to start a second instance while the first
    is still playing.
12. **Docs.** `docs/voice.md`: how ask aloud works, the capture rule, the limits, what stops
    speech.

## 6. Data and compatibility

One new config key with a default. No migration. An older listener's hello has no `speech` part
and reads as unable to play. With the `voice` flag off the routes answer 404 and no manager
runs.

## 7. Tests and verification

- `test/voice-speech.test.ts`: `askSentence` for two, three, one and four names; the Automatic
  rule for each catalog; the job's state transitions; each time limit with an injected clock;
  the queue; a dropped job; stop before and after `started`; an ask does not start while muted
  and an audition does.
- `test/voice-speech-http.test.ts`, the ordering the S9 rule needs, with a fake listener and an
  injected clock:
  a listener that keeps playing past the end limit: at the limit the job is `stopping`, the
  directive reads `{ id, stop: true }` with `capture` false, and an utterance posted then is
  refused with `while-speaking`; `capture` turns true only after the listener posts `ended`,
  and the job ends `timed-out`;
  a late start: `started` arriving after the start limit leaves the job `stopping` and
  `capture` false until `ended`;
  a stop request for a job the listener never received is answered with `ended` and ends it;
  a listener that ignores the stop: at the confirm limit the mode is `unavailable` with the
  `listener` reason and its sentence, and `capture` is still false;
  a second instance says hello while the first is still playing: the job is still `stopping`,
  the directive both of them read has `capture` false, the second is given no job, and an
  utterance from the second is refused with `while-speaking`. This holds whether or not the
  second instance was announced, and it still holds after muting and after voice is switched
  off and on;
  only the exit report for the first instance, or its own late `ended`, ends the job (`failed`
  for the exit report) and lets `capture` return; an exit report naming the second instance, or
  an unknown one, changes nothing, and one without the token is refused;
  an instance that was never announced is given no speech job, and `speech-output` says why;
  a click on Stop follows the same order;
  the next queued job does not start until the one before it is final.
- The same file: the directive shows `capture` false and `speak` while a job is live and returns
  to true after `ended`; an utterance captured during the job is refused with `while-speaking`;
  the audition route's 409;
  the audio route serves a held job's WAV from a fake synthesizer and answers 404 once the job
  is final.
- `test/voice-state.test.ts`: `speech-output` for each reason; a shell's claim is dropped.
- `renderToStaticMarkup` tests for the asking mark.
- `e2e/specs/voice-ask-aloud.spec.ts`, with `beSpeaker`: an unsure card reads "Asking aloud",
  and the mark goes when the fixture reports `ended`; Stop removes the mark at once; with the
  fixture still playing past the limit the mark goes at the limit, a sentence said then is
  listed in Recently heard as heard while speaking and does not route, and a sentence said
  after the fixture reports `ended` routes; with no speaker the Ask aloud choice is disabled
  and says why.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the tests and spec above.

## 8. Merge and exit criteria

With a fake listener that plays, one question is asked per unsure card, and capture is off from
the moment the job is handed over until the listener confirms it has ended. No limit, stop or
late start returns capture before that confirmation. A listener that never confirms leaves voice
not listening with the reason shown. Only that listener's late confirmation or its supervisor's
exit report restores it; a second listener saying hello does not. With no listener that can
play, the card behaves as it did before this phase.

## 9. Downstream handoff

Speech 2 replaces the refusing synthesizer and fills `catalog.neural` and `speech.model`; it
adds no route for the listener. Speech 3 implements the listener side of `speak` and the events
and fetches audio from this phase's audio route. Speech 4 writes
`config.speech.voice` and calls the audition route. None of them changes a name in contract L.

## 10. Cross-phase audit record

- The `speech` config field is owned here, not by Speech 4 as the plan's first revision said,
  because the job resolves a voice from it.
- Phase 12's step 5 and the Ask aloud clause of its step 6 are superseded by steps 7, 9 and 10
  here. The placement previews in that step stay with Phase 12.
- After Speech 3: the hotkey tap calls this phase's stop route.
- Completion review: the audio route is owned here and nowhere else, so Speech 3 can fetch
  audio without waiting for Speech 2.
- Plan validation round 2: a hello from a new instance used to end an unconfirmed job. It ends
  nothing now. The supervised-instances route in step 8 carries the only other ending, the
  exit report, and steps 3 and 5, the fixture and the tests changed.
- Plan validation round 1: a limit used to clear `speak` and let capture resume while the
  listener might still be playing. It now only requests a stop, and capture waits for the
  listener's `ended` or its replacement. Steps 3 and 5, the fixture and the tests changed.
