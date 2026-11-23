# Speech 1: the speech job and ask aloud

Part of `docs/plans/voice-spoken-responses/phased-plan.md`. Source plan: `plan.md` beside this
file. "Phase n" is a phase of `docs/plans/voice-addressing-for-agents/phased-plan.md`, the voice
plan. Owns the ask-aloud half of V14, the capture rule and stopping by a click.

## 1. Outcome

When routing is unsure and the operator chose Ask aloud, the daemon opens a speech job, tells the
listener to stop capture and speak, and returns capture when the listener says it has finished or
a time limit passes. The card shows that it is asking and can stop it. Everything is proven with
a fake listener that plays, so it runs on Linux CI with no audio.

## 2. Entry criteria

Phases 6 and 9 are merged. May run beside Phases 7, 8 and 10 to 16.

## 3. Scope and non-goals

In scope: contract L, the `speech` config field, the job and its limits, the capture rules, the
stop and audition routes, the `speak` directive, the hello's `speech` part, the daemon-owned
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
   unavailable: no listener, a listener that cannot play, no voice ready.
3. **Speech manager.** `src/server/voice/speech.ts`: one live job at a time and a queue in
   opening order; `open(purpose, text, cardId)`; `stop(id)`; the events route's `started` and
   `ended`; a timer per job that ends it as `timed-out` at the start limit, or at the audio
   length plus the end margin, or at the system limit when the length is unknown. A job whose
   card is settled before it starts is dropped. Clocks and timers are injected, as in the state
   store.
4. **Voice and audio.** The manager resolves the voice with `resolveSpeechVoice`. For a neural
   voice it calls the `VoiceSynthesizer` and holds the audio in memory for the audio route until
   the job is final. A synthesizer that rejects ends the job as `failed`. This phase ships one
   that refuses, and an empty neural catalog, so only system voices can be spoken.
5. **Directive.** Extend Phase 9's directive: `speak` carries the ready job, `capture` is false
   while a job is `ready` or `speaking`, and a change to either ends the long poll.
6. **Utterance guard.** The utterance route ignores an utterance whose `capturedAt` falls
   between a job becoming `ready` and its end, with the Recently heard reason `while-speaking`.
7. **Ask aloud.** When a card becomes `unsure`, `whenUnsure` is `ask`, the mode is `listening`
   and `speech-output` is available, open one `ask` job with `askSentence` of the candidates'
   names. A null sentence opens no job. A card gets at most one ask. Muting, a pick, a cancel
   and a settled card stop the job.
8. **Routes.** `POST /api/voice/speech/stop` stops the live job. `POST
   /api/voice/speech/audition` opens an `audition` job for the resolved voice with two roster
   names or "Steve or Stephen?", and answers 409 with the capability's reason when nothing can
   speak. The two token routes of contract L.
9. **Card.** `VoiceCardView` marks an `unsure` card whose id is the live job's `cardId` with
   "Asking aloud" and a Stop button. A candidate row and Cancel work as before and also stop the
   speech.
10. **Setting.** In the "When routing is unsure" row the Ask aloud choice is disabled, with the
    capability's reason as its description, while `speech-output` is unavailable. A stored `ask`
    is kept and behaves as `show` until speech is available.
11. **Fixture.** `beSpeaker` in `e2e/fixtures/voice.ts`, with options to delay or withhold
    `started` and `ended`.
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
- `test/voice-speech-http.test.ts`: the directive shows `capture` false and `speak` while a job
  is live and returns to true after `ended`; a late `ended` for a timed-out job is ignored; an
  utterance captured during the job is refused with `while-speaking`; the audition route's 409.
- `test/voice-state.test.ts`: `speech-output` for each reason; a shell's claim is dropped.
- `renderToStaticMarkup` tests for the asking mark.
- `e2e/specs/voice-ask-aloud.spec.ts`, with `beSpeaker`: an unsure card reads "Asking aloud",
  and the mark goes when the fixture reports `ended`; Stop ends it at once; with the fixture
  withholding `ended` the mark goes at the limit and a following sentence routes; with no
  speaker the Ask aloud choice is disabled and says why.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the tests and spec above.

## 8. Merge and exit criteria

With a fake listener that plays, one question is asked per unsure card, capture is off for
exactly the life of the job, and a silent listener cannot hold capture off past the limit. With
no listener that can play, the card behaves as it did before this phase.

## 9. Downstream handoff

Speech 2 replaces the refusing synthesizer and fills `catalog.neural` and `speech.model`.
Speech 3 implements the listener side of `speak` and the events. Speech 4 writes
`config.speech.voice` and calls the audition route. None of them changes a name in contract L.

## 10. Cross-phase audit record

- The `speech` config field is owned here, not by Speech 4 as the plan's first revision said,
  because the job resolves a voice from it.
- Phase 12's step 5 and the Ask aloud clause of its step 6 are superseded by steps 7, 9 and 10
  here. The placement previews in that step stay with Phase 12.
- After Speech 3: the hotkey tap calls this phase's stop route.
