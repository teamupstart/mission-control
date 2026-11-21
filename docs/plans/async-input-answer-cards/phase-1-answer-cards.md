# Phase 1: answer cards in the conversation

Part of `docs/plans/async-input-answer-cards/phased-plan.md`. Source plan: `plan.md` beside this
file. Scheduled as async-input Phase 4.

## 1. Outcome

With the `async-input` flag on, an answer delivered to the agent as a message appears in the
conversation as the same gold answer card the operator sees today, once, at the point the agent
received it. It never appears as a raw "mission control" or "you" turn. It keeps rendering that
way after a daemon restart and on reload. A Remind me later instruction appears as the snoozed
card line rather than raw text. The agent receives exactly what it receives today, below one
marker line.

## 2. Entry criteria

async-input Phase 2 (answer delivery and question lifecycle) and Phase 3 (dashboard surfaces) are
merged. Phase 1 is merged transitively.

## 3. Scope and non-goals

In scope: the marker line and its module, writing it at the queueing point, durable recognition
in transcript attribution, the Goal reader check, the presentation union, the dashboard
projection, placement and de-duplication, both renderings, the "What the agent received"
disclosure, the "On its way" and "Delivered" status lines, docs and tests.

Not in scope: answer wording or coalescing (Phase 2); the Asked entry and closed-state lines
(Phase 3); delivery timing; Foreman packets and workflow repair turns; gate reviews.

## 4. Repository findings and inherited contracts

Read `phased-plan.md`, section "Findings that shaped the phase". In short:

- Final row text is written in `queueReviewPendingTurn` (`src/server/db.ts`), where Phase 2 also
  coalesces. Compose the marker there, from every review id in the row.
- `pendingTurns` row ids are turn ids carrying the review id.
- Reviews can move to a runtime-transfer successor.
- `attributeTranscript` (`src/server/transcript-attribution.ts`) feeds every transcript reader.
- `TranscriptPresentation` (`src/shared/types.ts`) and `projectLaunchPresentation`
  (`src/web/lib/launch-presentation.ts`) are the existing presentation path.
- `mergeConversation` (`src/web/lib/episodes.ts`), `ReviewAnswerCard`
  (`src/web/components/ReviewAnswer.tsx`), `SnoozedReviewCard`
  (`src/web/components/ReviewSnooze.tsx`) and the chat and terminal turn renderings in
  `src/web/components/TranscriptPanel.tsx` draw the result.
- Inherited and unchanged: daemon authorship of answer rows, the `review-continuation:` prefix,
  escalation timings, Phase 2's text below the marker, Phase 3's entries.

## 5. Implementation steps

1. **Envelope module.** Create `src/shared/review-message-envelope.ts` (browser-safe, no `node:`
   import). Export the kinds (`answer`, `remind-later`), `formatReviewEnvelope(kind, ids)`
   returning `[mission-control:<kind> review=<id>]` or `reviews=<id>,<id>`, and
   `parseReviewEnvelope(text)` returning `{ kind, reviewIds, rest }` or `null`. Parse only the
   first non-blank line, accept only the exact grammar and UUID-shaped ids, and reject non-ASCII
   lines. No other module matches the string.
2. **Writer.** Where the outbox row text is written for a review (`queueReviewPendingTurn` and
   Phase 2's fold of a new answer into an unclaimed row), write the marker line, a blank line,
   then the row's existing text. When a fold adds an id, rewrite the line to list every id in
   delivery order. Apply it to message-mode answers always, and to call-mode late answers and
   snooze instructions only while `featureEnabled("async-input")`. The row id, authorship and
   escalation do not change.
3. **Recognition.** In `attributeTranscript`, for a user turn whose text parses, look up the ids
   with one bounded query (a new `db.ts` helper). Accept only when every id exists and belongs
   to this session or a session in its runtime-transfer lineage. Then set `origin: "harness"` and
   `presentation: { kind: "review-message", envelope, reviewIds }`. Otherwise leave the turn
   unchanged. Do not consult the flag.
4. **Goal reader.** In `Registry.captureHookGoalPrompt`, skip a prompt whose text passes the same
   recognition. Reuse step 3's helper; do not duplicate the check.
5. **Presentation type.** Make `TranscriptPresentation` a discriminated union: the existing
   `{ kind: "launch" | "resident"; displayText }` and the new `review-message` shape. Update
   every switch over it so the type checker enforces exhaustiveness.
6. **Projection.** Extend the dashboard projection so a `review-message` turn becomes a review
   row for its ids in envelope order, keeping the native message id and timestamp. Keep the raw
   text available to the disclosure and to find. Ids the dashboard cannot resolve to a review
   fall back to the raw turn, bylined Mission Control.
7. **Placement.** In `mergeConversation`, drop the `resolvedAt` entry of any review drawn at a
   delivery turn. A resolved review whose answer row is still in the session's `pendingTurns`
   stays at `resolvedAt` with "On its way to the agent". A call-mode answer returned through its
   call has neither, and stays exactly as today.
8. **Rendering.** Draw an answer row with `ReviewAnswerCard` in both the chat and terminal
   renderings, adding a "Delivered to the agent" line with the turn time and a "What the agent
   received" disclosure (a native `details` element, not a modal). Draw a `remind-later` row as
   the `SnoozedReviewCard` line. Keep the existing answerer label for Foreman and standing
   approvals. No `data-testid`; give the disclosure an accessible name.
9. **Docs.** Update `docs/sessions.md` (how answers appear) and `docs/attention-and-alerts.md`
   if it describes the delivered message. Commit this plan's Markdown
   (`docs/plans/async-input-answer-cards/plan.md`, `phased-plan.md`, this file) with the
   implementation pull request, as the repository's plan storage policy requires.

## 6. Compatibility

- Turns delivered before this phase have no marker and render as today.
- With the flag off, no marker is written for call-mode late answers or snooze instructions.
  Marked turns already in a conversation still render as cards.
- An old MCP child is unaffected; the daemon writes the marker.
- A review deleted by retention makes its turn fall back to raw text.

## 7. Tests and verification

- Unit: format and parse round trip; coalesced ids; malformed, partial, non-ASCII and
  non-first-line markers rejected; writer output for message-mode, call-mode-with-flag,
  call-mode-without-flag and snooze rows; a fold rewrites the line with every id;
  recognition accepts this session's and a transfer predecessor's ids, refuses another
  session's and unknown ids; `origin` is `harness` with an empty injection record (the restart
  case); the Goal reader skips a marked prompt and still captures an unmarked one;
  `mergeConversation` places one card per review at the delivery turn, at `resolvedAt` with "On
  its way" while queued, and leaves a call-returned answer unchanged; authorship and escalation
  tests from Phases 1 and 2 still pass against marked rows.
- Playwright, flag on, fake agents, no model tokens: an answer from the inbox appears as one gold
  card in chat and terminal renderings, with no visible "Mission Control review" text and no
  "you" byline; the disclosure shows the raw text; after a daemon restart and reload it is still
  a card; two answers coalesced into one delivery draw two cards on one turn; Remind me later
  with a provisional option draws the snoozed line. Attach screenshots to the pull request; do
  not commit them.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## 8. Exit criteria

Flag on: no delivered answer or Remind me later instruction is visible as raw daemon text in the
conversation, before or after a restart; each answer shows exactly one card; the agent's received
text is unchanged below the marker. Flag off: every existing spec passes unchanged.

## 9. Downstream handoff

The default-on and flag-retirement pull requests may rely on the marker module as the only
definition of the line, and on `review-message` as the presentation for every outbox message
about a review. Retiring the flag makes the writer unconditional; it must not change the grammar.

## 10. Cross-phase audit

- Against async-input Phase 2: this phase writes only the first line of rows Phase 2 composes and
  coalesces, and must keep them daemon-authored with unchanged escalation.
- Against async-input Phase 3: this phase moves and de-duplicates the answer card for a delivered
  review; the Asked entry and closed-state lines stay Phase 3's.
- Final audit: owns every requirement of the source plan, sections 1 to 5, and all three adopted
  decisions.
