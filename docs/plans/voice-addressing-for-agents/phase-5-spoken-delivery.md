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
- A `pending_turns` row is `queued`, `sending` or `uncertain` (`src/shared/types.ts:182`) and
  exists until delivery is confirmed. Confirmation deletes the row and announces it once through
  `Registry.turnDelivered` (`src/server/registry.ts:2107`, called from `journalDelivered`,
  `src/server/pending-turns.ts:1488`). A claim is not a delivery: a claimed row is `sending`,
  and one whose handoff cannot be proven is `uncertain`.
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
   `VOICE_TURN_PREFIX`. At submit the row's text is the operator's words alone, and the same
   words are stored in a new column, `spoken_words`. It is an operator turn: it counts toward the
   Goal as a typed message does.
3. **Composing at delivery.** When the outbox claims a spoken turn, before it registers an echo
   expectation or sends anything, it computes the notes from the agent's state at that moment,
   writes the row's text as `spokenMessageText(spoken_words, notes)` and stamps a new column,
   `composed_at`, in the transaction that claims the turn. A row with `composed_at` set is sent
   as stored: a retry, a second claim or a restart after composition resends that text and does
   not compose again, so notes are neither lost nor doubled. A restart before the claim leaves
   the words in the row, and the notes are computed when it is next claimed. Echo matching and
   steer receipts read the composed text.
4. **Outcomes.** A `VoiceDeliverer` that replaces Phase 3's default, deciding in this order:
   - the target's state is `not-running`: outcome `not-running`, nothing queued, with the target's
     kind so the card can choose its hint;
   - the state is `hibernated`: resume the task, then `submitSpoken`, outcome `queued`;
   - the session has a pending call-mode ask: `submitSpoken`, outcome `held`;
   - the session is working: `queued`; idle: `sent`.
   The card's `openQuestions` count is filled from `openAsks`.
5. **Stop.** `stop` interrupts through `interruptSession` and, where the harness cannot be
   interrupted, reports `failed` with the reason.
6. **Foreman hold.** `voiceHold(sessionId)` is true in three cases, and in no other:
   - a pending card targets the session, until it is cancelled or handed to delivery;
   - a spoken turn's row exists for the session, in any state: `queued`, `sending` or
     `uncertain`. The row is there until delivery is confirmed, so this covers a turn waiting
     behind a question (the `held` outcome), a turn that was claimed and composed but whose
     send failed or is being retried, and one whose handoff is uncertain. It has no time
     limit: Foreman stays off that session's questions however long the message waits.
     Recalling or removing the row ends it. `composed_at` is not read here, because it is
     stamped at the claim and says nothing about delivery;
   - the spoken turn's delivery has been confirmed (`turn_delivered` for its id) and the
     agent's turn that received it has not ended, for at most 10 minutes after that event's
     `deliveredAt`. The limit guards against a turn end that is never observed and cannot
     start before the delivery is confirmed.
   The second case is read from the row, so it survives a daemon restart with it. The third
   is in memory and lapses on a restart, by which time the agent has the message.
   `foremanWriteRefusal` refuses review writes for a held session with the reason
   `voice-message-pending`.
7. **Conversation.** Present a turn with the voice prefix as `spoken_words` with a small
   "Spoken" mark and a "What the agent received" disclosure, following the review-message model.
8. **Docs.** `docs/voice.md`, `docs/sessions.md`, `docs/foreman.md`,
   `docs/database-and-migrations.md`.

## 6. Data and compatibility

One migration: two nullable columns on `pending_turns`, `spoken_words` and `composed_at`. An
existing database opens unchanged and other turns leave both null. It takes the next schema
number at merge time. A spoken turn's row survives a daemon restart as any pending turn does, and
so does its hold, which is the row's existence. A pending card is in memory, so a card lost in a
restart is not delivered and holds nothing. The hold after a confirmed delivery is in memory.

## 7. Tests and verification

- `test/voice-delivery.test.ts`: the text builders and note order.
- `test/voice-delivery-http.test.ts`: idle, busy, hibernated, exited, a resident with no run, a
  pending call-mode ask and stop.
- `test/voice-spoken-turn.test.ts`: a queued turn whose open questions change before delivery
  carries the later list; a daemon restart before delivery keeps the words and composes once; a
  retry after composition resends the same text with one set of notes; the echo is matched on
  the composed text.
- A database upgrade test for the two columns.
- `test/voice-foreman-hold.test.ts`: refused while held, allowed after the turn ends and after a
  cancel. With the `held` outcome and the clock moved past 10 minutes, Foreman is still refused
  on the blocking question; it is still refused after a daemon restart; it is allowed once the
  queued turn is removed. A turn that was claimed and composed but whose send keeps failing
  sits past 10 minutes with `composed_at` set: Foreman is still refused. An `uncertain` row
  holds until the operator settles it. After `turn_delivered`, the hold ends when the agent's
  turn ends, and 10 minutes after `deliveredAt` when that end is never observed.
- `e2e/specs/voice-spoken-message.spec.ts`: say "Steve, check the build" to a fake session with an
  open question; its conversation shows "check the build" marked Spoken; the disclosure shows the
  open-questions note and the post-a-report line.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

Each agent state yields its outcome. A typed message is unchanged. Foreman cannot answer a held
session's question, for as long as a spoken message for that session has not been delivered.

## 9. Downstream handoff

Phase 6 draws the outcomes. Phase 15 turns most `held` outcomes into deliveries. Contract F's
text builders are also what phases 13 and 14 use when an answer falls back to a message.

## 10. Cross-phase audit record

- After Phase 15: `held` remains for a waiter that did not state the capability.
- After Phase 14: spoken inbox actions do not create spoken turns; Nudge and Continue send the
  inbox plan's fixed messages.
- Plan validation round 1: steps 2 and 3 now say where the words live, when the notes are
  composed and what a retry or restart does. The earlier text said both "created with the full
  text" and "computed at delivery".
- Pull request review, third round: the hold ended 10 minutes after the card opened, so with
  the `held` outcome Foreman could answer the question the message was waiting behind. The
  hold now lasts while the turn is undelivered, the 10 minutes count from delivery, and the
  hold is read from the row so a restart does not drop it.
- Pull request review, fifth round: that fix took `composed_at` for delivery, but step 3 stamps
  it at the claim, before anything is sent, so a composed turn that was retried or still
  waiting was already on the 10-minute clock. The hold now follows the repository's own
  delivery fact: the row exists until delivery is confirmed, and the clock starts at
  `turn_delivered`.
