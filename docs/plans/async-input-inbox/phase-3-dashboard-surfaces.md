# Phase 3: dashboard surfaces

Part of `docs/plans/async-input-inbox/phased-plan.md`. Source plan: `plan.md` beside this file.

## 1. Outcome

The operator can see, wherever a question appears, whether its agent is still working or has
stopped on it, and what the agent is doing meanwhile. A working session shows its open questions
without turning amber, the conversation records the question where it was asked and how it
ended, and Remind me later reads correctly for an agent that is already carrying on.

## 2. Entry criteria

Phase 1 is merged. May run concurrently with Phase 2.

## 3. Scope and non-goals

In scope: the question card, inbox ordering and copy, the state badge, the conversation entry,
Remind me later under async (its small daemon rule included), the Residents drawer, CSS, specs
and docs. Not in scope: a new view, auto-opening anything, alert rules and how merge closures
are written (Phase 1), how withdrawals are written (Phase 2).

## 4. Repository findings and inherited contracts

- Inherited from Phase 1: `waitMode`, `meanwhile`, `closedReason` (already written by Phase 1
  for every outstanding `request_input` question a merge closes, in either wait mode),
  `withdrawn`, `Session.openQuestions`, the idle clause and amber label in
  `unpausedStateDisplay`, and the rule that a resident is never amber for open questions alone.
- `ReviewCard` is shared by the review modal, the inbox and ensemble lanes:
  `src/web/components/ReviewModal.tsx:130-419`.
- Inbox rows, row Dismiss tooltip and ordering: `src/web/components/AttentionInbox.tsx:246-262`,
  `326-354`; `src/web/lib/attention.ts:386-420`.
- State badge and its review button: `src/web/components/session-bits.tsx:1730-1771`; label and
  tone in `src/web/lib/format.ts:307-345`; the `e` shortcut in `src/web/lib/review-shortcut.ts`.
- The conversation shows only resolved and snoozed reviews: `src/web/lib/timelineReviews.ts:31-106`,
  `src/web/lib/episodes.ts:44-75`, `src/web/components/TranscriptPanel.tsx:1357-1362`; history
  from `GET /api/sessions/:id/resolved-reviews`.
- Snooze sheet and labels: `src/web/components/ReviewSnooze.tsx:70-177`,
  `src/shared/review-snooze.ts`. The instruction is owed when nobody is listening and the wait
  is detached: `snoozeReviewRow`, `src/server/db.ts:5253-5297`. A message-mode row is always
  both.
- The Residents drawer puts a resident in its needs-you group only when its session's tone is
  attention: `entryNeedsYou`, `src/web/residents/ResidentsDrawer.tsx:50-68`. Wired in
  `src/web/App.tsx:2128`, `2683-2692`.
- Modal inset rule and `expectContentClearsBorder`: `AGENTS.md`, `e2e/fixtures/modal-inset.ts`.

## 5. Implementation steps

1. **Card status line.** On a message-mode question, `ReviewCard` shows under the title either
   "Still working" with the `meanwhile` line, or "Stopped, waiting on this answer", from the
   asking session's live state through the shared bucket, plus how long ago it was asked. A
   resident between iterations reads "Still working", because it wakes on its own. The card
   needs its session where it is rendered; the three callers pass it. Call-mode cards are
   unchanged.
2. **Inbox.** In "Questions from agents", sessions that have stopped sort first, then oldest
   question first. The row Dismiss tooltip for a row of message-mode questions says the agent
   keeps working and the questions stay open.
3. **State badge.** While a session works with `openQuestions > 0`, the badge reads "N questions
   open" in the working tone and is a button that opens that session's review modal. A resident
   with questions open gets the same chip while idle between iterations. The `e` shortcut
   reaches such sessions after every session that has stopped.
4. **Conversation.** Add an "Asked" entry at the question's creation time for message-mode
   questions, with an Answer button that opens the card while it is open. Closed states read
   "Closed unanswered: pull request merged" for `closedReason: "merged"`, "Closed unanswered"
   for any other orphaning, and "Withdrawn by the agent" with its reason for `withdrawn`. The
   merge closure line is shown for every `request_input` question that carries the reason,
   whichever way it waited: on the Asked entry of a message-mode question, and in place of the
   Snoozed entry of a call-mode question that was snoozed when the merge closed it. The gold
   answer entry still lands at the resolution time. Extend the history route so merge-closed
   and withdrawn questions survive a reload.
5. **Remind me later.** For a message-mode question the sheet's first Meanwhile choice reads
   "Keep doing what it said" and stays the default; the mode id remains `judgment`. In
   `snoozeReviewRow`, a message-mode row snoozed in `judgment` mode owes no instruction;
   `option` and `hold` owe it as today. Reword the reminder banner and snoozed-row lines that
   say what the agent "has been doing" so they are true when it never waited.
6. **Residents drawer.** `entryNeedsYou` also admits a resident whose session has
   `openQuestions > 0`, so it is listed in the needs-you group with its asks while its tone
   stays working or idle.
7. **Styling and docs.** New elements follow the modal inset rule. Update `docs/ui.md`,
   `docs/attention-and-alerts.md`, `docs/sessions.md` (Remind me later) and `docs/residents.md`.

## 6. Compatibility

- A review without `waitMode` renders exactly as today on every surface, apart from the merge
  closure line on a call-mode question that carries `closedReason`.
- `closedReason` is written from Phase 1 on. `withdrawn` may be absent until Phase 2 merges;
  every surface must render without it.
- No `data-testid`; select by role, label or text.

## 7. Tests and verification

- Unit: the status line for working, stopped, unconfirmed and resident sessions; ordering; badge
  label and tone; conversation placement for open, answered, orphaned and withdrawn questions,
  and for a merge closure in both wait modes; snooze labels; no instruction owed for `judgment`
  on a message-mode row, owed for `option` and `hold`; drawer grouping; the attention-pill
  invariant.
- Playwright, flag on, fake agents, no model tokens: the inbox card shows "Still working" with
  its meanwhile line, then "Stopped, waiting on this answer"; stopped sessions sort first; the
  badge of a working session opens its questions; the conversation shows the Asked entry and
  then the answer, and the merge closure line after a merge; the Remind me later sheet shows the
  new default and the snoozed row; the Residents drawer lists a working resident's question.
  Each spec that opens a modal calls `expectContentClearsBorder`. Attach screenshots to the pull
  request; do not commit them.
- Electron geometry test if the status line can overflow a narrow card.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## 8. Exit criteria

Flag off: no visible change. Flag on: every surface in section 5 distinguishes working from
stopped, no question is visible in one place and missing from another, and a question closed by
a merge is recorded in the conversation in either wait mode.

## 9. Downstream handoff

The later flag pull requests may rely on these surfaces being complete. Nothing here may be
used as a second source of state: all of it renders `ReviewItem` and `Session`.

## 10. Cross-phase audit

- Against Phase 1: the amber label, the idle clause, the resident exemption and both completion
  rules are Phase 1's; this phase adds the working-tone branch beside them and must keep
  `reportBucket` and `unpausedStateDisplay` in agreement. Alert wording is Phase 1's.
- Against Phase 2: this phase reads `withdrawn` and `response` and writes neither. The only
  daemon edits are `snoozeReviewRow` and the history route, which Phase 2 does not touch.
- Plan validation round 1: `closedReason` is now written by Phase 1, not Phase 2, and for
  call-mode questions too. The conversation therefore renders the merge closure line in both
  wait modes, so the closure the operator chose is never silent.
- Final audit: owns source-plan section 5 except alerts, and the drawer line of section 6.
