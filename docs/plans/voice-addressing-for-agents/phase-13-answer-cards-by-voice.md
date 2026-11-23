# Phase 13: answering question cards by voice

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V23, V26, V27, V28 and V33. Mock-ups: `mockup-answer-card-by-voice.html`,
`mockup-voice-hints.html`.

## 1. Outcome

With an agent's question card open, the operator answers it by voice: the option is ticked
visibly, Submit counts down, and "cancel" or "no, A" changes course. Cards say what can be said.

## 2. Entry criteria

Phase 6 is merged.

## 3. Scope and non-goals

In scope: contract J, answer forms in the router, option letters, the countdown footer, the foot
line on question cards, docs and specs. Not in scope: plan-decision forms and report or Stuck
cards (Phase 14).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- A question card is `ReviewCard` (`src/web/components/ReviewModal.tsx:133`) with `DecisionForm`
  (`src/web/components/PlanDecisions.tsx`). Its draft lives in `src/web/lib/review-drafts.ts`; an
  outside write re-renders each card showing that review (`useReviewDraft`, `:252`).
- An answer is sent with `POST /api/reviews/:id/resolve` (`src/server/routes.ts:6077`,
  `ResolveReviewSchema` at `src/shared/protocol.ts:1054`).
- Nothing reports open cards to the daemon (`src/web/App.tsx:454`, `:458`).
- Inherited: the router (contract D), `ask` with `option` questions (contract E), spoken delivery
  (contract F), the card's bar and buttons (contract G), and from the inbox plan `INBOX_ACTIONS`,
  `SpokenHint` and the name line on `ReviewCard`.

## 5. Implementation steps

1. **Open cards.** The dashboard sends contract J's report when the set of drawn question cards
   changes and when the window gains or loses focus: each card's kind, its review id and whether
   it holds focus. The daemon finds each card's agent from the review, keeps the focused window's
   report and drops it 10 seconds after that window's event stream closes. The voice target for
   an agent is its one open card, or the focused one when several are open; otherwise there is no
   target.
2. **Letters.** `optionLetter(index)` (A, B, C) in shared code. `DecisionForm` prints the letter
   on each option row while the voice flag is on.
3. **Answer forms**, added to the router ahead of the name rule. They are V23's two cases, and
   speech reaches a card through nothing else:
   - the explicit answer phrase, from anywhere: "<name>, answer: ...", "<name>, option B" or
     "option two", "<name>, go with your recommendation". Which question it answers depends on
     how many `input` reviews that agent has pending:
     - one: that review, whether or not its card is open;
     - several, and one of them is the voice target: the target;
     - several and no voice target: nothing is answered yet. The router opens a question pick
       and keeps the words. Picking a row applies them to that question as step 4's pending
       answer; Cancel drops them;
     - none: there is nothing to answer, and the sentence is delivered as a spoken message.
   - a bare "<name>, answer", with no words after it, never answers anything. With at least
     one `input` review pending it opens a question pick, also when there is only one. Picking
     a row asks the focused dashboard to open that question's card, as the held card's Open
     question control does on a click; the open card is then the voice target (step 1), so
     "reply, ..." or "<name>, ..." answers it. With no dashboard connected the card says to
     open the dashboard. With none pending the card reads "<name> has no open questions" and
     nothing is sent.
   - the open-card signal: with a target card open, "<name>, ..." or "reply, ...". "reply" with
     no name uses the focused card.
   Other speech to an agent whose card is not open is delivered as a message and touches no card.
   A letter, an ordinal or an exact label is matched without a model; other wording goes to
   `ask` as an `option` question. A match ticks the option. No match: with the card open the words
   become the card's text answer; from anywhere they are delivered as a spoken message.
   With a card open, naming a different agent routes to that agent as usual.
   A question pick is an `unsure` card whose candidates are of kind `question` (contract D):
   that agent's pending `input` reviews in the order they were asked, each row showing its
   ordinal, title and age. A row is picked by a click or by saying its ordinal alone ("first
   one", "the second"), which the router treats as `control` while the pick is open; both use
   the pick route. It has no deadline. When the picked review is no longer pending, the card
   says so and nothing is sent. This phase adds the question row to `VoiceCardView`.
4. **Pending answer.** The daemon holds a `VoiceAnswer { reviewId, selections, text, deadline }`,
   emits `voice_answer`, and at the deadline resolves the review as the human through the resolve
   path. The answer registers in `pendingVoiceActions` (contract D) when it opens. A bare
   "cancel" stops the newest pending voice action of any kind, so it clears this answer when the
   answer is the newest, and stops a message routed after it when that is newer; a second
   "cancel" then clears the answer. "No, A" acts on the newest pending voice answer, whatever
   opened after it: it replaces the selection and restarts the deadline, and keeps the entry's
   place in the order. With the cancel window off it resolves at once. When no dashboard is
   showing that card, the router also opens a `pending` voice card whose text is the answer, so
   the countdown and Cancel stay on screen. That card and the answer are one entry: stopping
   either stops both.
5. **Card.** On `voice_answer` the dashboard writes the selection or text into the review draft
   with a voice mark, and `ReviewCard` swaps its action row for the countdown footer: what will
   be sent, the seconds, Cancel and Submit now. A click on another option during the window
   cancels the voice answer.
6. **Hints.** Turn the voice-hints context on while the mode is not `off`. That also reveals the
   two answer hints on Phase 6's sent, queued and held cards, which are drawn through
   `SpokenHint` and stay hidden until now. `CardVoiceFoot` prints
   one line at the foot of a question card: Say "<name>, option B" to answer; or, for an agent
   with no spoken name, Say "reply, option B" while this card is open.
7. **Docs.** `docs/voice.md`, `docs/attention-and-alerts.md`.

## 6. Data and compatibility

No storage; a pending answer is in memory and is dropped on restart. With the flag off no letter,
foot line or report exists.

## 7. Tests and verification

- `test/voice-answer-routing.test.ts`: each form, the target rule, a second agent named, no name,
  an explicit phrase with no card open, and plain speech with no card open. The overlap, in both
  orders: with an answer pending and then a message routed to another agent, "cancel" stops the
  message and the answer still resolves, and a second "cancel" clears the answer; with the
  message pending first and then the answer, "cancel" clears the answer and the message is
  still delivered. "No, A" with a newer message pending switches the answer and leaves the
  message alone. An answer with a companion card is cancelled as one entry. The count rule for
  "<name>, answer: use Postgres": one pending answers it; two pending with one the voice
  target answers the target; two pending and no card open opens a question pick with two rows
  and answers nothing, picking the second by ordinal creates the pending answer for that
  review with those words, and Cancel drops them; none pending delivers the sentence as a
  message. A bare "<name>, answer": with two pending it opens the pick and picking a row asks
  the dashboard to open that review and answers nothing; with one pending it still opens the
  pick; with none it says there are no open questions and sends nothing. A picked review that
  has since settled sends nothing.
- `test/voice-answer-http.test.ts`: deadline resolve, cancel, switch, window off, a review that
  settles meanwhile.
- `e2e/specs/voice-answer-card.spec.ts`: open Steve's question; say "Steve, option B"; B is ticked
  and the footer counts down; say "no, A"; A is ticked; after the window the card is answered
  with A. Say "reply, neither yet" on a nameless agent's card; the text box fills and submits.
  With the inbox closed, "Steve, do X" is delivered as a message and the card is untouched;
  "Steve, option B" with the inbox closed shows a voice card that counts down, and the question
  is then answered with B.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

Speech answers a card through step 3's signals and through nothing else. A voice answer is visible
before it is sent and can be cancelled or switched.

## 9. Downstream handoff

Phase 14 extends the open-cards report with report and Stuck cards and reuses `CardVoiceFoot`.

## 10. Cross-phase audit record

- After Phase 14: plan-decision reviews are excluded from step 3 here and handled there.
- Plan validation round 1: V23 now states the two cases in which speech reaches a card, and step
  3 names them instead of restating a rule of its own.
- Pull request review: step 4 said "cancel" clears the answer while Phase 3 said it cancels the
  newest pending card. Both now follow contract D's one order, and the overlap is tested.
- Pull request review, fifth round: Phase 6's sent card tells the operator to say "<name>,
  answer", and step 3 defined neither that bare phrase nor an answer phrase with several
  questions pending and no card open; "with none" could also be read as no pending reviews.
  Step 3 now decides by the number pending, and both undefined cases open a question pick.
  Phase 6 draws its two answer hints through `SpokenHint`, so they appear when this phase
  turns hints on and not before the phrases work.
