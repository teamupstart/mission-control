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

- Inherited from Phase 2: `ReportItem` with `repository` and a null `followUpTaskId`,
  `GET /api/sessions/:id/reports`, `ReportCard`, `openReportId`, the read route, `markRead`, and
  the `toggle` and `mark-read` actions.
- Conversation rows are merged in `mergeConversation` (`src/web/lib/episodes.ts:83`); review rows
  come from `useTimelineReviews` (`src/web/lib/timelineReviews.ts:33`) and render in
  `src/web/components/TranscriptPanel.tsx:1365`. History is read per session, as
  `GET /api/sessions/:id/resolved-reviews` does (`src/server/routes.ts:7225`).
- An operator message goes through `POST /api/sessions/:id/send` (`routes.ts:6205`) to
  `PendingTurnManager.submit` (`src/server/pending-turns.ts:303`), which refuses a session that
  cannot receive messages and queues behind a busy one.
- The model for a self-contained message is `asyncInputAnswer` (`src/shared/async-input.ts:142`).
- There is no follow-up path. A task is created with `POST /api/tasks` (`routes.ts:9230`) and
  dispatched with `POST /api/tasks/:id/dispatch` (`routes.ts:9864`). They are two steps, so the
  second can fail after the first succeeded.
- A resident that is running has an entry in `residentRuns`; one with no open run is not running.

## 5. Implementation steps

1. **Text builders** in `src/shared/reports.ts`: `reportReplyText(report, words, now)` gives
   "Reply to your report '<title>' (<id>), posted N minutes ago", the report's title and body,
   then the operator's words. Also `unseenReportsNote(reports)`, `POST_REPORT_LINE` ("When you
   have finished this, post a report.") and `resolveMarkReadTarget(authorKey, reports,
   openReportId)`, which returns the open report, else the author's only unread report, else
   null. Nothing in this plan calls the last three; voice does.
2. **Reply.** `POST /api/reports/:id/reply { text }` submits `reportReplyText` through
   `pendingTurns.submit` as an operator message and, when the submit succeeds, calls
   `markRead(id, "reply")`. A refused submit leaves it unread and returns the reason.
3. **Reply target.** A pure `replyTarget(report, sessions, residentRuns)` returns `live`,
   `resident-not-running`, `gone` or `gone-no-repository`. The card draws a reply box; or the
   line "<name> isn't running" with a sentence saying to launch the resident from the Residents
   drawer, which is text and not a control; or a text box with **Start a follow-up task**; or,
   when the report stored no repository, a line saying a follow-up cannot be started from here.
4. **Follow-up.** `POST /api/reports/:id/follow-up { text }` works in two recorded steps and
   never resumes the old session:
   - If `followUpTaskId` is null, create a task in `report.repository` whose intent is the
     operator's words followed by the report, and store its id on the report in the same
     transaction as the task row. If it is set, reuse that task and create nothing.
   - Dispatch that task if it has not been dispatched. On success call
     `markRead(id, "follow-up")`: the follow-up is the reply to an agent that is gone, so it
     clears the report as a reply does (R9, R11). On failure return the error and the task id,
     and leave the report unread.
   After a failed dispatch the card reads "Follow-up task created but not started" and draws the
   same `follow-up` action under the label **Retry**. It calls the same route, so it dispatches
   the one existing task.
5. **Conversation entry.** A `ReportEntryCard` at the report's `createdAt`: a "Report" tag, the
   title, the body behind the `toggle` action, its version when it replaced one, how it was
   cleared (read, replied to, or followed up), and the `mark-read` action while it is unread.
   Both are drawn with `InboxActionButton`, and the entry's file joins the Phase 1 scan. Every
   version is an entry. Live entries come from the stream and older ones from the history route.
6. **Actions.** Declare `reply` and `follow-up` in `INBOX_ACTIONS` with the forms in the index
   table. `follow-up` is one entry drawn under two labels, Start a follow-up task and Retry,
   through `InboxActionButton`'s label override. Retry is not a separate action and has no
   spoken form of its own: "{name}, follow up, ..." retries when a task already exists.
7. **Docs.** `docs/sessions.md` and `docs/attention-and-alerts.md`.

## 6. Data and compatibility

No migration: `follow_up_task_id` exists from Phase 2. A reply is an ordinary operator turn, so
it is echoed and captured as one. With the flag off the routes refuse and no entry renders.

## 7. Tests and verification

- Unit tests for the four builders and `replyTarget`, including the no-repository case.
- `test/reports-reply-http.test.ts`: a live session, a busy session (queued, still marked read
  with `readBy` `reply`), an exited session (refused, still unread).
- `test/reports-follow-up-http.test.ts`: a follow-up after the session was evicted uses the
  stored repository and marks the report read with `readBy` `follow-up`; a dispatch that fails
  leaves one task, the report unread and `followUpTaskId` set; a retry dispatches that same
  task, creates no second one and marks the report read; two concurrent calls create one task; a
  report with no repository is refused.
- `test/inbox-actions.test.ts` covers `reply` and `follow-up`, asserts that the Retry button
  carries the `follow-up` action id, and scans the conversation entry file.
- `e2e/specs/reports-reply.spec.ts`: reply from the inbox; the fake agent's conversation shows a
  message starting "Reply to your report"; the report leaves to read and its entry reads as
  replied. End the session: the card offers Start a follow-up task; pressing it produces a new
  running task, takes the report out of to read, and its entry reads as followed up. A resident
  with no run shows the not-running line. Every agent stays faked.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

- A reply reaches the agent with its report named and restated, and clears the report.
- A follow-up clears the report once its task has been dispatched, and not before. A report has
  at most one follow-up task however often the route is called.
- Every control on the report card and its conversation entry, Retry included, is a declared
  action.
- No path resumes a completed session. The conversation shows every version of every report.

## 9. Downstream handoff

Phase 4 adds Open report to `ReportCard` and `ReportEntryCard`. Voice calls the builders and
`resolveMarkReadTarget`; their signatures are fixed here.

## 10. Cross-phase audit record

- The reply is operator-authored, not daemon-authored, so an instruction given in a reply counts
  toward the agent's Goal like any typed message. The source plan's design section says the same.
- After Phase 4: the entry card keeps a slot for Open report; no route here changes.
- After Phase 7: a muted author's entries still render here, as R29 requires.
- Plan validation round 1: the follow-up now reads `repository` from the report, not from a live
  session, and records `followUpTaskId` before dispatching, so a failed dispatch is retried on
  the same task. Both fields are owned by Phase 2.
- Plan validation round 2: R9 and R11 now say a dispatched follow-up clears the report, which is
  what step 4 does. Retry is the `follow-up` action under another label. The relaunch hint is
  text. The conversation entry's two controls are declared actions and its file is scanned.
