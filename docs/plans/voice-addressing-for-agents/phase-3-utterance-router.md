# Phase 3: utterance route and router

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V5, V9, V11, V12 and V36.

## 1. Outcome

Text posted to the daemon as an utterance is routed by name, held for the cancel window and
delivered to the named agent as a queued message. What was heard and why is kept in memory.

## 2. Entry criteria

Phase 2 is merged.

## 3. Scope and non-goals

In scope: contract D, the deterministic router, the cancel window, the Recently heard buffer, the
`say` fixture, docs and tests. Not in scope: any model call (Phase 4), notes and delivery outcomes
(Phase 5), any dashboard surface (phases 6 and 7), audio.

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- A token-checked route follows `POST /hooks/:event` (`src/server/routes.ts:5026-5031`); the token
  is read with `readClientToken` (`src/shared/harness-runtime.mjs:136`).
- An operator message is queued through `PendingTurnManager.submit`
  (`src/server/pending-turns.ts:355`), which refuses a session that cannot be messaged.
- Inherited: the roster and `phoneticKey` (contract C); `cancelWindow`, the mode and `beListener`
  (contracts A and B).

## 5. Implementation steps

1. **Pure router.** `routeUtterance` in `src/shared/voice-routing.ts`, in this order:
   - a bare "cancel": `control`;
   - while an `unsure` card is open, an utterance that is one candidate's name: `control` (pick);
   - the first one or two words equal a roster name and the gap to the next word is at least
     `pauseMs`: `addressed`, with the rest of the text verbatim and match `exact`;
   - the same with an equal `phoneticKey`, or a possessive: `addressed`, match `phonetic`;
   - a leading word one edit from two names, or a second roster name later in the text:
     `needs-model` with the candidates;
   - anything else: `ignored`, with the reason (`no-name`, `no-pause`, `near-miss` and the closest
     name).
   "<name>, stop" is `addressed` with the command `stop`. The roster's state does not affect
   matching; delivery decides what a name that is not running means.
2. **Route.** `POST /voice/utterances` validates contract D's body and hands it to a server
   `VoiceRouter` while the mode is `listening` or `push-to-talk`; in another mode it is dropped.
3. **Cards and the window.** For `addressed`, the router opens a `pending` card with a deadline
   from `cancelWindow` and delivers at the deadline; with the window off it delivers at once.
   Cancel, Send now and pick routes act on a card. A pending card registers itself in
   `pendingVoiceActions` (contract D) when it opens and leaves when it is delivered, sent now or
   cancelled. "Cancel" by voice stops the newest entry in that list, and a second "cancel" the
   next newest. The list takes any kind of entry, so Phases 13 and 14 add theirs without
   changing the rule. With the list empty, "cancel" does nothing and is listed in Recently heard
   with the reason `nothing-pending`. A `needs-model` decision opens an `unsure` card in this
   phase. An open `unsure` card registers in the list too and has no deadline: it leaves when
   a row is picked or when it is cancelled, by voice or through the cancel route, and a
   cancelled one sends nothing.
4. **Delivery seam.** `VoiceDeliverer.deliver(target, text, utteranceId)` returns an outcome. The
   default deliverer calls `submit` with the plain text for a running target and reports `sent`
   or `failed`; `stop` calls the interrupt path (`src/server/routes.ts:6889`).
5. **Recently heard.** A ring buffer of 50 `HeardEntry` values in memory: time, text, outcome,
   rule, matched name, pause and detail. Cancelled utterances are listed. Nothing is written to
   disk, and a dropped utterance is not recorded.
6. **Fixture.** `say(daemon, text, options)` in `e2e/fixtures/voice.ts` makes sure `beListener` is
   running, builds word timings from the text, with a pause after the first word unless told
   otherwise, and posts with the token.
7. **Docs.** Routing rules and the privacy statement in `docs/voice.md`; the events in
   `docs/event-stream.md`.

## 6. Data and compatibility

No storage. The routes answer 404 with the flag off. `voice_card` is a new event, handled in
`src/web/useEventStream.ts` by keeping a map of cards for phases 6 and 12.

## 7. Tests and verification

- `test/voice-routing.test.ts`: each rule, "Will you grab the door" against "Will, grab the
  door", Steven and Steve's, a second name, the pick rule.
- `test/voice-utterances-http.test.ts`, with a hello sent first: the token check, the flag gate, a
  muted drop, a pending card that delivers at its deadline, cancel by route and by voice, Send
  now, the window off. Two cards pending: "cancel" stops the newer and the older still
  delivers; a second "cancel" stops the older; a third is listed as `nothing-pending`. With an
  `unsure` card open, "cancel" closes it and nothing is delivered.
- `test/voice-heard.test.ts`: the ring bound, the reasons, clear.
- Run `npm run typecheck`, `npm run lint` and the three tests.

## 8. Merge and exit criteria

Posting "Steve, check the build" with a pause queues "check the build" to Steve after the window.
The same words without the pause are ignored and listed with the reason.

## 9. Downstream handoff

Phase 4 replaces the `unsure` shortcut for `needs-model` with the model step. Phase 5 replaces the
default deliverer. Phases 5, 6, 7, 12, 13 and 14 use `say` and the routes. Contract D's shapes do
not change.

## 10. Cross-phase audit record

- After Phase 5: the default deliverer is removed there; `stop` keeps its path.
- After Phase 13: answer forms ("option B", "answer:", "reply") are added to the router by that
  phase, ahead of the name rule, and do not change the rules above.
- Pull request review: "the newest pending card" left open what a bare "cancel" stops once
  Phase 13 adds pending answers. Step 3 now owns one ordered list for every kind of pending
  voice action, and contract D states the rule.
