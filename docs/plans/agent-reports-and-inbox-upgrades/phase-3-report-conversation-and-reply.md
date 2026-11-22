# Phase 3: report conversation entry, reply and follow-up

Part of `docs/plans/agent-reports-and-inbox-upgrades/phased-plan.md`. Source plan: `plan.md`
beside this file. Owns R5, R10, R11 and R26.

## 1. Outcome

A report appears in its agent's conversation where it was posted. The operator replies from the
report card and the agent receives a message that names the report it answers. When the agent is
gone, the card says so and offers the right next step.

## 2. Entry criteria

Phase 2 is merged. May run concurrently with Phases 5 and 6.

## 3. Scope and non-goals

In scope: the conversation entry, the reply route and box, the gone-agent states, Start a
follow-up task, the text builders voice will use, docs and specs. Not in scope: Open report on a
document (Phase 4), appending anything to typed or spoken messages (voice), resuming a completed
session.

## 4. Repository findings and contracts

- Inherited from Phase 2: `ReportItem`, `GET /api/sessions/:id/reports`, `ReportCard`,
  `openReportId`, the read route.
- Conversation rows are merged in `mergeConversation` (`src/web/lib/episodes.ts:83`); review rows
  come from `useTimelineReviews` (`src/web/lib/timelineReviews.ts:33`) and render in
  `src/web/components/TranscriptPanel.tsx:1365`. History is read per session, as
  `GET /api/sessions/:id/resolved-reviews` does (`src/server/routes.ts:7225`).
- An operator message goes through `POST /api/sessions/:id/send` (`routes.ts:6205`) to
  `PendingTurnManager.submit` (`src/server/pending-turns.ts:303`), which refuses a session that
  cannot receive messages and queues behind a busy one.
- The model for a self-contained message is `asyncInputAnswer` (`src/shared/async-input.ts:142`).
- There is no follow-up path. A task is created with `POST /api/tasks` (`routes.ts:9230`) and
  dispatched with `POST /api/tasks/:id/dispatch` (`routes.ts:9864`).
- A resident that is running has an entry in `residentRuns`; one with no open run is not running.

## 5. Implementation steps

1. **Text builders** in `src/shared/reports.ts`: `reportReplyText(report, words, now)` gives
   "Reply to your report '<title>' (<id>), posted N minutes ago", the report's title and body,
   then the operator's words. Also `unseenReportsNote(reports)`, `POST_REPORT_LINE` ("When you
   have finished this, post a report.") and `resolveMarkReadTarget(authorKey, reports,
   openReportId)`, which returns the open report, else the author's only unread report, else
   null. Nothing in this plan calls the last three; voice does.
2. **Reply.** `POST /api/reports/:id/reply { text }` submits `reportReplyText` through
   `pendingTurns.submit` as an operator message and, when the submit succeeds, marks the report
   read with `readBy: "reply"`. A refused submit leaves it unread and returns the reason.
3. **Reply target.** A pure `replyTarget(report, sessions, residentRuns)` returns `live`,
   `resident-not-running` or `gone`. The card draws a reply box; or "<name> isn't running" with a
   hint to launch the resident from the Residents drawer; or a text box with **Start a follow-up
   task**.
4. **Follow-up.** `POST /api/reports/:id/follow-up { text }` creates a task in the report's
   repository whose intent is the operator's words followed by the report, dispatches it, and
   marks the report read with `readBy: "follow-up"`. It never resumes the old session.
5. **Conversation entry.** A `ReportEntryCard` at the report's `createdAt`: a "Report" tag, the
   title, the body behind a disclosure, its version when it replaced one, whether it was read or
   replied to, and Mark read. Every version is an entry. Live entries come from the stream and
   older ones from the history route.
6. **Actions.** Declare `reply` in `INBOX_ACTIONS` ("{name}, ..." and "reply, ...") and place its
   hint on the card.
7. **Docs.** `docs/sessions.md` and `docs/attention-and-alerts.md`.

## 6. Data and compatibility

No new storage. A reply is an ordinary operator turn, so it is echoed and captured as one. With
the flag off the routes refuse and no entry renders.

## 7. Tests and verification

- Unit tests for the four builders and `replyTarget`.
- `test/reports-reply-http.test.ts`: a live session, a busy session (queued, still marked read),
  an exited session (refused, still unread), follow-up creating and dispatching one task.
- `e2e/specs/reports-reply.spec.ts`: reply from the inbox; the fake agent's conversation shows a
  message starting "Reply to your report"; the report leaves to read and its entry reads as
  replied. End the session: the card offers Start a follow-up task and pressing it produces a
  new running task. A resident with no run shows the not-running hint. Every agent stays faked.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

A reply reaches the agent with its report named and restated, and clears the report. No path
resumes a completed session. The conversation shows every version of every report.

## 9. Downstream handoff

Phase 4 adds Open report to `ReportCard` and `ReportEntryCard`. Voice calls the builders and
`resolveMarkReadTarget`; their signatures are fixed here.

## 10. Cross-phase audit record

- The reply is operator-authored, not daemon-authored, so an instruction given in a reply counts
  toward the agent's Goal like any typed message. The source plan's design section says the same.
- After Phase 4: the entry card keeps a slot for Open report; no route here changes.
- After Phase 7: a muted author's entries still render here, as R29 requires.
