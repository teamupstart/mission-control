# Phase 14: plan forms and inbox actions by voice

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V29 and V42. Mock-ups: `mockup-plan-decisions-by-voice.html`,
`mockup-voice-hints.html`.

## 1. Outcome

A plan-decision form can be filled by voice and waits for "submit". Report and Stuck cards accept
their spoken actions ("Steve, mark read", "Steve, nudge"). A setting turns the form surface off.

## 2. Entry criteria

Phase 13, filed Phase 2 (the revised-form card), and inbox phases 4, 5 and 7 (the last report and
Stuck actions) are merged.

## 3. Scope and non-goals

In scope: form filling, submit and its refusal, ordinal badges, the setting, spoken inbox actions,
foot lines on report and Stuck cards, docs and specs. Not in scope: new inbox actions, a spoken
form for a control the inbox plan declares click-only.

## 4. Repository findings and inherited contracts

- A plan form is a `plan-decisions` review drawn by `DecisionForm`; it may carry a daemon-appended
  approval decision when it is a managed final bundle.
- The inbox plan declares each card control once in `INBOX_ACTIONS` with a spoken form or a
  click-only reason, and runs a click and any other caller through one action function. Its
  `resolveMarkReadTarget` decides which report "mark read" means.
- Inherited: contract J, the answer machinery and `CardVoiceFoot` (Phase 13), `planFormsByVoice`
  (contract A).

## 5. Implementation steps

1. **Form grammar.** With a plan form as the voice target: "<name>, first one B, second one A"
   (also "reply, ..."). Ordinals count the form's decisions in drawn order, the appended approval
   decision included. A letter picks that decision's option. Other wording for one decision goes
   to `ask`.
2. **Fill state.** The daemon holds a `VoiceFormFill { reviewId, selections }` for the form and
   emits `voice_form_fill`. It is a separate record from Phase 13's `VoiceAnswer`, on purpose:
   it has no deadline, it fills and does not submit, it is not an entry in
   `pendingVoiceActions`, and it is not a pending voice answer. So a bare "cancel" never
   clears it, and "no, A" never rewrites it. A filled decision is changed by saying it again
   ("<name>, first one A") or by a click.
   The dashboard mirrors each fill into the draft with a voice mark. Clicks and
   voice edit the same draft, and the draft is what is submitted; the daemon's fill state is
   never submitted by itself. The fill state is cleared when the review stops being pending
   (answered, dismissed, withdrawn or replaced by a revised form), when `planFormsByVoice` is
   turned off, and 10 minutes after the last open-cards report that listed the form. Clearing it
   changes no draft: what was mirrored stays in the browser.
3. **Submit.** "<name>, submit" or "reply, submit", while the agent has a pending plan form. It
   acts only when that form is the agent's voice target at that moment, which means a dashboard
   has it open (contract J). The daemon then asks that dashboard to submit its draft, so clicks
   made meanwhile are included. A spoken submit is the operator's confirmation (V29), so it
   has no cancel window and is not an entry in `pendingVoiceActions` either. The request
   carries a `submitId` the daemon issued, and the
   dashboard sends it back as `voiceSubmitId` on the resolve route. When a decision is
   unanswered the submit is refused: the card marks that decision and the voice card says which
   one and how to say it.
   When no dashboard has the form open, the submit is refused with the reason `form-not-open`:
   the review is not resolved, the words are not delivered to the agent as a message, the fill
   state is kept, and the voice card reads "Open <name>'s plan form to submit it". The same
   refusal applies when the dashboard that was asked does not resolve or refuse within 5
   seconds, for example because it closed in that moment. At that point the daemon revokes the
   `submitId`, and the resolve route refuses a resolve that carries a revoked or unknown
   `voiceSubmitId`: the review stays pending and the dashboard keeps its draft. A dashboard
   that was only slow therefore cannot submit after the card has said nothing was sent. An id
   is used once, and the timeout and the resolve are decided in the daemon in the order they
   arrive. A resolve with no `voiceSubmitId` is a click and is unaffected. With no plan form
   pending for that agent, "<name>, submit" is plain speech and is delivered as a message.
4. **Badges.** While the voice flag is on and the setting is on, each decision of a plan form
   wears an ordinal badge (1st, 2nd, 3rd) beside its question, blue once voice fills it and amber
   while a refused submit waits on it.
5. **Setting.** When `planFormsByVoice` is off: steps 1 to 4 do not apply, no badge or foot line is
   drawn on plan forms, and speech addressed to that agent is delivered as a message. Question
   cards and inbox actions are unaffected.
6. **Inbox actions.** Extend the open-cards report with report and Stuck cards. The router builds
   its action phrases from `INBOX_ACTIONS`: "<name>, <spoken form>". An action runs its action
   function after the cancel window, shown as a voice card ("Steve: mark read"). That card is a
   `pending` card, so it is an entry in `pendingVoiceActions` and a bare "cancel" stops it when
   it is the newest pending voice action (contract D). "Mark read" follows
   `resolveMarkReadTarget`; when it returns none the card says to open the report first.
   "Reply, ..." with a report or Stuck card open sends the words through that card's reply or
   message action. "<name>, stop" stays Phase 5's interrupt.
7. **Foot lines.** `CardVoiceFoot` on report, Stuck and plan-form cards, listing that card's
   spoken forms from the registry in one sentence.
8. **Docs.** `docs/voice.md`, `docs/attention-and-alerts.md`.

## 6. Data and compatibility

No storage. Fill state is in memory and is dropped on restart and by step 2's rules; the draft in
the browser keeps what was mirrored. `ResolveReviewSchema` gains an optional `voiceSubmitId`;
live ids are in memory, so after a restart a pending voice submit is refused as unknown.

## 7. Tests and verification

- `test/voice-plan-form.test.ts`: ordinals with and without the approval decision, a refused
  submit, the setting off. A submit with the form filled and no dashboard showing it is refused
  as `form-not-open`, resolves nothing, queues no message and keeps the fill state; so is a
  submit whose dashboard never answers. A slow dashboard: the request times out and is refused,
  then the dashboard resolves with that `voiceSubmitId`; the resolve is refused, the review is
  still pending and the agent receives nothing. A resolve inside the 5 seconds succeeds once
  and its id cannot be used again. "<name>, submit" with no plan form pending is a
  message. The fill state is cleared when the review settles, when the setting is turned off
  and 10 minutes after the form was last reported open. The cancel order: route a message to
  Alice, fill Steve's form while that message is still in its window, then say "cancel";
  Alice's message is stopped and Steve's fill and draft are unchanged. A second "cancel" is
  listed as `nothing-pending` and still changes no fill. With a question card's answer
  counting down and a form filled after it, "no, A" switches the answer and changes no
  decision on the form.
- `test/voice-inbox-actions.test.ts`: a phrase for each spoken action in the registry, no phrase
  for a click-only one, the mark-read target, and "cancel" inside the window leaving the report
  unread.
- `e2e/specs/voice-plan-form.spec.ts`: a three-decision form; say "Steve, first one B, second one
  A"; two badges turn blue; "Steve, submit" is refused and the third is marked; fill it; submit;
  the form is answered. On a second form: fill it by voice, close the inbox so the form is no
  longer drawn, and say "Steve, submit"; the voice card says to open Steve's plan form and the
  form is still unanswered; open it again and the filled options are still ticked. With the
  setting off, the same words arrive as a message.
- `e2e/specs/voice-inbox-actions.spec.ts`: "Steve, mark read" with one unread report clears it
  after the window; "Steve, nudge" sends the fixed nudge message.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the specs.

## 8. Merge and exit criteria

A plan form is submitted by voice on "submit", when complete and while a dashboard has it open,
and not otherwise. Each spoken inbox action does what its click does.

## 9. Downstream handoff

None inside this plan.

## 10. Cross-phase audit record

- The inbox plan's action table is the list of spoken forms; this phase adds none and changes
  none.
- Pull request review: a pending inbox action is cancelled by the same rule as a routed message
  and a voice answer, contract D's newest pending voice action.
- Pull request review, third round: step 3 covered a submit only while a dashboard had the form
  open, and nothing said when a fill state ends. A submit with the form not open is now refused
  and says to open it, the daemon never submits its own fill state, and step 2 lists what
  clears the fill state.
- Pull request review, fourth round: after the 5-second refusal a slow dashboard could still
  resolve the review, so the card would say nothing was sent while the agent got the answers.
  Each submit request now carries an id that the daemon revokes at the timeout and the resolve
  route refuses.
- Pull request review, seventh round: step 2 reused `VoiceAnswer` for the fill state, and
  Phase 13 registers a `VoiceAnswer` in the cancel order and makes it the target of "no, A".
  A fill with no deadline would have stayed the newest entry, so "cancel" meant for a routed
  message would have wiped the form. The fill state is now its own record, `VoiceFormFill`,
  outside the cancel order and outside "no, A", and the sequence is tested.
