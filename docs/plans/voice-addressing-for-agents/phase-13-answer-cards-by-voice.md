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
3. **Answer forms**, added to the router ahead of the name rule:
   - explicit, from anywhere: "<name>, answer: ...", "<name>, option B" or "option two",
     "<name>, go with your recommendation". These target the agent's one pending `input` review,
     open or not; with several pending they need a target.
   - with a target card open: "<name>, ..." or "reply, ...". "reply" with no name uses the
     focused card.
   A letter, an ordinal or an exact label is matched without a model; other wording goes to
   `ask` as an `option` question. A match ticks the option. No match: with the card open the words
   become the card's text answer; from anywhere they are delivered as a spoken message.
   With a card open, naming a different agent routes to that agent as usual.
4. **Pending answer.** The daemon holds a `VoiceAnswer { reviewId, selections, text, deadline }`,
   emits `voice_answer`, and at the deadline resolves the review as the human through the resolve
   path. "Cancel" clears it. "No, A" replaces the selection and restarts the deadline. With the
   cancel window off it resolves at once.
5. **Card.** On `voice_answer` the dashboard writes the selection or text into the review draft
   with a voice mark, and `ReviewCard` swaps its action row for the countdown footer: what will
   be sent, the seconds, Cancel and Submit now. A click on another option during the window
   cancels the voice answer.
6. **Hints.** Turn the voice-hints context on while the mode is not `off`. `CardVoiceFoot` prints
   one line at the foot of a question card: Say "<name>, option B" to answer; or, for an agent
   with no spoken name, Say "reply, option B" while this card is open.
7. **Docs.** `docs/voice.md`, `docs/attention-and-alerts.md`.

## 6. Data and compatibility

No storage; a pending answer is in memory and is dropped on restart. With the flag off no letter,
foot line or report exists.

## 7. Tests and verification

- `test/voice-answer-routing.test.ts`: each form, the target rule, a second agent named, no name.
- `test/voice-answer-http.test.ts`: deadline resolve, cancel, switch, window off, a review that
  settles meanwhile.
- `e2e/specs/voice-answer-card.spec.ts`: open Steve's question; say "Steve, option B"; B is ticked
  and the footer counts down; say "no, A"; A is ticked; after the window the card is answered
  with A. Say "reply, neither yet" on a nameless agent's card; the text box fills and submits.
  With the inbox closed, "Steve, do X" is delivered as a message and the card is untouched.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

Speech answers a card through step 3's signals and through nothing else. A voice answer is visible
before it is sent and can be cancelled or switched.

## 9. Downstream handoff

Phase 14 extends the open-cards report with report and Stuck cards and reuses `CardVoiceFoot`.

## 10. Cross-phase audit record

- After Phase 14: plan-decision reviews are excluded from step 3 here and handled there.
