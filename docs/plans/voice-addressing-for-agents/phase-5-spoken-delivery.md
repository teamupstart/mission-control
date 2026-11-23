# Phase 5: spoken delivery

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V17, V18, V19, V20, V21, V22, V24 and V30.

## 1. Outcome

A spoken message reaches its agent as the operator's words plus daemon-written notes, in whatever
state the agent is in, and Foreman leaves that agent's questions alone meanwhile. The conversation
shows the words and can disclose what the agent received.

## 2. Entry criteria

Phase 3, inbox Phase 3 (the report text builders) and filed Phase 1 (`ReviewManager.openAsks`) are
merged.

## 3. Scope and non-goals

In scope: contract F, the notes, the outcomes, resume, the Foreman hold, the conversation entry,
docs and tests. Not in scope: converting a blocking question (Phase 15), the cards (Phase 6).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- `submit` takes text verbatim (`src/server/pending-turns.ts:355`). Daemon authorship is a turn-id
  prefix (`daemonAuthorOf`, `:167`). An echo is matched by exact text
  (`src/shared/message-delivery.ts:95-130`) and by fingerprint (`src/server/injections.ts:455`).
- Review answers show one text and send another: `reserveReviewDelivery` and `reviewMessageTurns`
  (`src/server/review-deliveries.ts:109`, `:296`), drawn by `ReviewDeliveryNote`
  (`src/web/components/ReviewAnswer.tsx:158`).
- A hibernated task resumes through `src/server/hibernation/manager.ts:291`; queued turns are held
  until the session is bound again.
- Foreman is refused by `foremanWriteRefusal` (`src/server/routes.ts:1022`), which already reads
  the composer-activity lease (`src/server/composer-activity.ts:43`).
- Inherited: `VoiceDeliverer` (contract D); `SpokenName.state` (contract C); from the inbox plan
  `POST_REPORT_LINE` and `unseenReportsNote`.

## 5. Implementation steps

1. **Text.** `src/shared/voice-delivery.ts`: `openQuestionsNote(asks)` lists each open ask's id
   and title and asks the agent to withdraw, with a reason, any the message settles.
   `spokenMessageText(words, notes)` is the words, a blank line, then the notes in a fixed order:
   open questions, unseen reports, the post-a-report line.
2. **Spoken turn.** `submitSpoken` creates a pending turn whose id starts with
   `VOICE_TURN_PREFIX` and whose text is `spokenMessageText`. It is an operator turn: it counts
   toward the Goal as a typed message does. Echo expectations use the full text. The notes are
   computed when the turn is delivered, not when it is queued.
3. **Outcomes.** A `VoiceDeliverer` that replaces Phase 3's default, deciding in this order:
   - the target's state is `not-running`: outcome `not-running`, nothing queued, with the target's
     kind so the card can choose its hint;
   - the state is `hibernated`: resume the task, then `submitSpoken`, outcome `queued`;
   - the session has a pending call-mode ask: `submitSpoken`, outcome `held`;
   - the session is working: `queued`; idle: `sent`.
   The card's `openQuestions` count is filled from `openAsks`.
4. **Stop.** `stop` interrupts through `interruptSession` and, where the harness cannot be
   interrupted, reports `failed` with the reason.
5. **Foreman hold.** `voiceHold(sessionId)` is set when a card targets a session and cleared when
   the spoken turn's own turn ends, when the card is cancelled, or after 10 minutes.
   `foremanWriteRefusal` refuses review writes for a held session with the reason
   `voice-message-pending`.
6. **Conversation.** Present a turn with the voice prefix as the operator's words with a small
   "Spoken" mark and a "What the agent received" disclosure, following the review-message model.
7. **Docs.** `docs/voice.md`, `docs/sessions.md`, `docs/foreman.md`.

## 6. Data and compatibility

No migration: the turn uses the existing `pending_turns` row. A queued spoken turn survives a
daemon restart as any queued turn does; the hold is in memory and lapses on restart.

## 7. Tests and verification

- `test/voice-delivery.test.ts`: the text builders and note order.
- `test/voice-delivery-http.test.ts`: idle, busy, hibernated, exited, a resident with no run, a
  pending call-mode ask, stop, and notes computed at delivery.
- `test/voice-foreman-hold.test.ts`: refused while held, allowed after the turn ends and after a
  cancel.
- `e2e/specs/voice-spoken-message.spec.ts`: say "Steve, check the build" to a fake session with an
  open question; its conversation shows "check the build" marked Spoken; the disclosure shows the
  open-questions note and the post-a-report line.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

Each agent state yields its outcome. A typed message is unchanged. Foreman cannot answer a held
session's question.

## 9. Downstream handoff

Phase 6 draws the outcomes. Phase 15 turns most `held` outcomes into deliveries. Contract F's
text builders are also what phases 13 and 14 use when an answer falls back to a message.

## 10. Cross-phase audit record

- After Phase 15: `held` remains for a waiter that did not state the capability.
- After Phase 14: spoken inbox actions do not create spoken turns; Nudge and Continue send the
  inbox plan's fixed messages.
