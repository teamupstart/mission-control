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
2. **Fill state.** The daemon holds a `VoiceAnswer` for the form with no deadline: it fills and
   does not submit. The dashboard mirrors each fill into the draft with a voice mark. Clicks and
   voice edit the same draft.
3. **Submit.** "<name>, submit" or "reply, submit". When a dashboard has the form open, the daemon
   asks it to submit its draft, so clicks made meanwhile are included. When a decision is
   unanswered the submit is refused: the card marks that decision and the voice card says which
   one and how to say it.
4. **Badges.** While the voice flag is on and the setting is on, each decision of a plan form
   wears an ordinal badge (1st, 2nd, 3rd) beside its question, blue once voice fills it and amber
   while a refused submit waits on it.
5. **Setting.** When `planFormsByVoice` is off: steps 1 to 4 do not apply, no badge or foot line is
   drawn on plan forms, and speech addressed to that agent is delivered as a message. Question
   cards and inbox actions are unaffected.
6. **Inbox actions.** Extend the open-cards report with report and Stuck cards. The router builds
   its action phrases from `INBOX_ACTIONS`: "<name>, <spoken form>". An action runs its action
   function after the cancel window, shown as a voice card ("Steve: mark read"). "Mark read"
   follows `resolveMarkReadTarget`; when it returns none the card says to open the report first.
   "Reply, ..." with a report or Stuck card open sends the words through that card's reply or
   message action. "<name>, stop" stays Phase 5's interrupt.
7. **Foot lines.** `CardVoiceFoot` on report, Stuck and plan-form cards, listing that card's
   spoken forms from the registry in one sentence.
8. **Docs.** `docs/voice.md`, `docs/attention-and-alerts.md`.

## 6. Data and compatibility

No storage. Fill state is in memory and is dropped on restart; the draft in the browser keeps what
was mirrored.

## 7. Tests and verification

- `test/voice-plan-form.test.ts`: ordinals with and without the approval decision, a refused
  submit, the setting off.
- `test/voice-inbox-actions.test.ts`: a phrase for each spoken action in the registry, no phrase
  for a click-only one, the mark-read target.
- `e2e/specs/voice-plan-form.spec.ts`: a three-decision form; say "Steve, first one B, second one
  A"; two badges turn blue; "Steve, submit" is refused and the third is marked; fill it; submit;
  the form is answered. With the setting off, the same words arrive as a message.
- `e2e/specs/voice-inbox-actions.spec.ts`: "Steve, mark read" with one unread report clears it
  after the window; "Steve, nudge" sends the fixed nudge message.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the specs.

## 8. Merge and exit criteria

A plan form is submitted by voice on "submit" and when complete, and not otherwise. Each spoken
inbox action does what its click does.

## 9. Downstream handoff

None inside this plan.

## 10. Cross-phase audit record

- The inbox plan's action table is the list of spoken forms; this phase adds none and changes
  none.
