# Phase 2: Live activity in the transcript

## Outcome

The "running Bash" line stops being fixed chrome pinned to the top of the pane and becomes what it
actually is - the in-progress state of the turn currently arriving at the bottom of the log. The
whole leading status band, two blocks plus 36px of separator, stops existing.

Delivers the activity half of decision **D4**.

## Entry criteria and dependencies

**Direct prerequisite: Phase 1.** Phase 1 removes `GoalLine` from `.detail-conv`; this phase removes
the remaining `.activity` paragraph from the same container and edits the same file region. Starting
before phase 1 merges puts two agents in the same forty lines.

## Scope

1. Remove `{session.activity && <p className="activity">…</p>}` from `ConsoleDetail.tsx:525`.
2. Render a ghosted trailing row in the transcript log when the session is live and has an activity
   string.
3. Fix the two stick-to-bottom defects that row would otherwise introduce.
4. Distinguish it, in copy and in docs, from the "Observed activity" rail beside the log.

### Non-goals

- `SessionCard.tsx:446` keeps its own `.activity` paragraph. The card is not the console detail; it
  has no room for a transcript tail and `test/session-card-goal.test.ts:123-129` pins the card's
  goal/activity separation.
- The launcher strip and tab row. Phase 3.
- The "Observed activity" rail itself. It is derived from `messages` and is a different feature.

## Repository findings

- **The append point is `TranscriptPanel.tsx:822`**, immediately after the `session.pendingTurns` map
  and before the closing `</div>` of `.transcript-log`. `PendingTurnView` is the existing precedent
  for a trailing synthetic block in that container.
- **Ordering question the implementation must answer:** `pendingTurns` are the *human's* queued
  messages. A "currently running" agent row rendered after them reads as happening later than
  messages that have not been sent yet. Decide deliberately and record the choice in the PR; placing
  the ghost row *before* the pending turns is the likelier correct answer.
- `.transcript-log` is `display: flex; flex-direction: column; gap: 10px` (`styles.css:4740-4748`), so
  any appended node also costs a 10px gap. Keep the row to a single line.
- **F4, defect one:** `TranscriptPanel.tsx:583-593` re-pins the log in a `useLayoutEffect` keyed on
  `[messages, session.pendingTurns]`. A row driven by `session.activity` changes `scrollHeight`
  without re-running it, so a bottom-pinned reader silently drifts off whenever the activity text
  changes height. **Fix: add the ghost row's driver to that dependency array.**
- **F4, defect two:** `onScroll` (`:600-608`) computes `atBottom` as
  `scrollHeight - scrollTop - clientHeight < 48`. A row taller than 48px appearing under a
  bottom-pinned reader flips `atBottom` false and the pane stops following the tail. **Keeping the
  row to one line is therefore a correctness requirement, not a style preference.**
- `scrollByArrow` (`:406-410`) and `scrollToEpisode` (`:402-405`) both operate on `logRef`, so the
  ghost row is inside their scroll surface and must not break arrow-key scrolling.
- **F5:** `ConversationActivity` (`ConversationActivity.tsx:9-18`) is the "Observed activity" rail,
  derived from `messages` rather than `session.activity`, and its language contract explicitly
  forbids implying that a tool is *running*. A ghost row six inches away saying "running Bash" sits
  against that contract. Frame the new row as the current turn's in-progress state and make the docs
  distinguish the two.
- `test/transcript-scroll-electron.test.ts:190-193` lays out the real panel under both hosts and
  measures `logHeight`, `contentHeight`, `scrolledTo` and `composeBottomOverflow` at five widths. A
  permanently present row changes all of those numbers; the row must be conditional on live state so
  the idle-session cases are unchanged, and the fixture may need a case added rather than edited.

## Implementation steps

1. Add the trailing row to `.transcript-log` in `TranscriptPanel.tsx`, gated on the session being live
   and `session.activity` being non-empty. Give it a stable key that does not collide with
   `row.id` / `ep-*` / `rv-*`.
2. Decide and implement its position relative to `session.pendingTurns`, per the ordering finding
   above.
3. Extend the `useLayoutEffect` dependency array at `:593` to include whatever drives the row, so a
   bottom-pinned reader stays pinned when the text changes.
4. Constrain the row to a single line with ellipsis. This is load-bearing for the 48px threshold.
5. Style it as clearly not-a-turn - muted, with the working tone for its marker - reusing existing
   tokens. Do not introduce a new colour.
6. Remove the `.activity` paragraph from `ConsoleDetail.tsx:525`. Leave `SessionCard.tsx:446` alone.
   **Do not introduce a wrapper around the remaining children of `.detail-conv`**; `.detail-conv >
   .pane-dialog` (`test/pane-dialog-scroll.test.ts:100-104`) and `.detail-conv > .transcript`
   (`styles.css:18086-18094`) are child combinators.
7. **Docs:** `docs/sessions.md:976-978` says the activity ticker is "on its own line", which becomes
   false for the console detail. `docs/sessions.md:842-846` describes the Observed activity rail and
   now needs a sentence distinguishing it from the in-progress row, or readers meet two things called
   activity.

## Tests and verification

- Unit: the row is absent for an idle session, absent when `activity` is null, present for a live
  session with activity.
- Keep `test/pane-dialog-scroll.test.ts` and `test/workflows-tab.test.ts` passing without editing
  them; both assert `.detail-conv` structure and are the guard on step 6.
- Run `test/transcript-scroll-electron.test.ts` and reconcile deliberately. If numbers move, add a
  case for the live-with-activity state rather than loosening an existing assertion.
- **New Playwright spec** in `e2e/`, modelled on `e2e/specs/driver-question-in-conversation.spec.ts`
  and `e2e/specs/review-answers-in-conversation.spec.ts`, which are the existing patterns for things
  rendered inside the log. Assert the in-progress row appears at the tail for a working session and
  that the old leading status line is gone from `.detail-conv`. Per `e2e/README.md`, make the element
  present before asserting its absence elsewhere; do not assert absence cold.
- Verify stick-to-bottom by hand or in the spec: with the log at the bottom, an activity change must
  leave it at the bottom.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.

## Merge and exit criteria

- The console detail Conversation tab has no leading status band; `.transcript` is the first thing
  under the tab row.
- A working session shows a single-line in-progress row at the tail of the log.
- A reader pinned to the bottom of the log stays pinned across an activity change.
- `SessionCard` is unchanged.
- Full suite green including a new e2e spec.

## Downstream handoff

Phase 3 may rely on:

- `.detail-conv` having no leading children, with `.transcript` as a direct child, and must preserve
  the no-wrapper rule.
- The in-progress row being the only place `session.activity` appears in the console detail. Phase 3
  must not reintroduce it into the header while re-laying out the bands.

## Cross-phase audit record

- **Against phase 1:** phase 1 removes `GoalLine` from `.detail-conv` and this phase removes
  `.activity` from the same container. Confirmed the two edits do not overlap in line range but do
  overlap in file, which is why the dependency is declared rather than run concurrently. Moved the
  "no wrapper inside `.detail-conv`" rule to be stated in **both** phases, since either could break
  the child combinator, and recorded it as a contract in the index.
- Confirmed phase 1's `.detail-title` column is untouched here.
