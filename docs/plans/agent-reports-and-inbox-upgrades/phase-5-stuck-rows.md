# Phase 5: Stuck rows

Part of `docs/plans/agent-reports-and-inbox-upgrades/phased-plan.md`. Source plan: `plan.md`
beside this file. Owns R15, R16 and R17.

## 1. Outcome

A session the daemon detects as stalled gets a row in a new **Stuck** inbox section. The row says
which rule fired and why, and the operator fixes it in place: nudge it, interrupt it, tell it to
continue, mark its task done, resubmit its run, tell it to push, or answer what Foreman escalated.

## 2. Entry criteria

Phase 1 is merged. May run concurrently with Phases 2, 3, 4, 6 and 7.

## 3. Scope and non-goals

In scope: structured stall facts, the fold item, the section and cards, the fixed-message route,
dismissal, docs and specs. Not in scope: changing when a rule fires or its sentence, any Cancel
control, a way to close a queue from the inbox, stall settings UI, notifications (Phase 6 adds
the switch).

## 4. Repository findings and contracts

- Inherited: `INBOX_FLAG`, `agentDisplayName`, `INBOX_SECTION_ORDER`, `INBOX_ACTIONS`,
  `InboxActionButton`.
- The rules are `detectStall` (`src/shared/stall.ts:226`): `escalated`, `silent-working`,
  `unfinished-work`, `workflow-parked`. A `Stall` carries only `sessionId`, `kind`, `forMs`,
  `reason` and `workflowRunId` (`stall.ts:80`). The parked sentence is built in `parkedReason`
  (`stall.ts:186`) and includes the unpushed clause from `src/shared/unpushed.ts`.
- `unfinished-work` has two sources (`workOutstanding`, `stall.ts:154`): the session's task is
  open, or its queue has open items and is not drained. A session can have a queue and no task.
  A task is completed by `POST /api/tasks/:id/complete` (`src/server/routes.ts:10032`). No route
  completes a queue; its items are managed in the session.
- Stalls are computed in the away watcher (`src/server/away/watcher.ts:156`), served at
  `GET /api/away/stalls` (`routes.ts:7702`) and already polled into `src/web/App.tsx` through
  `useStalls` (`src/web/lib/stalls.ts:33`).
- Whether a parked run reopens by itself is `workflowRunResumesItself`
  (`src/shared/workflow.ts:2569`). Resubmit refuses `waiting_for_new_head` and externally sourced
  runs (`src/server/workflows/manager.ts:2237`).
- An escalation is `session.note` with `disposition === "escalated"` (`stall.ts:241`).
- Other routes that exist: interrupt (`routes.ts:6884`), resubmit (`routes.ts:3326`), send
  (`routes.ts:6205`).
- A queued row is the operator's unless `daemonAuthorOf` recognises its id prefix
  (`src/server/pending-turns.ts:157`).
- Dismissal keys use `occurrenceOf` (`src/web/lib/attention.ts:318`). The backstop reads
  `represented` (`attention.ts:361`). `test/attention-pill-invariant.test.ts` pins to answer
  against need you.

## 5. Implementation steps

1. **Stall facts.** Add `facts`, discriminated by kind: `silent-working` (the activity line,
   quiet since); `unfinished-work` (`task`: the open task's id and title, or null when no task
   is open; `queueOpen`: the number of open queue items, zero when none); `workflow-parked` (run
   id, workflow name, status, round, `resubmittable`, `unpushedCommits`); `escalated` (the note
   text). Add `fingerprint`: the kind and those facts with every clock left out. `reason` keeps
   its wording.
2. **Fold.** With the flag on, each stall whose session is live becomes a `session_stuck` item
   (`stuck:<sessionId>`), placed by `INBOX_SECTION_ORDER`, counted once in `total`. Its session
   joins `represented` before the backstop runs. Its dismissal key is
   `occurrenceOf(kind, fingerprint)`, so it stays dismissed while minutes pass and returns when
   the facts change.
3. **Fixed messages.** The three texts from the source plan live in `src/shared/inbox.ts`.
   `POST /api/sessions/:id/inbox-message { kind: "nudge" | "continue" | "push" }` queues one
   with the id prefix `inbox-message:`, which `daemonAuthorOf` treats as daemon-written, so it is
   never captured as the agent's Goal.
4. **Cards.** One `StuckCard`, titled with the display name and the reason.
   - Silent while working: Nudge, Interrupt.
   - Idle with work open: what is open, and Continue. **Mark done** is drawn only when
     `facts.task` is set, and it completes that task through the existing route. When only a
     queue is open the card names the count, says the queue's items are handled in the session,
     and offers Continue; it draws no Mark done, because there is no task to complete.
   - Parked run: the missing step, Resubmit only when `resubmittable`, Tell it to push only when
     `unpushedCommits > 0`, and Open run.
   - Escalation: the note and a reply box that sends a normal operator message.
   Every card has a message box and Open session. A failed action shows its error under the row.
   There is no Cancel.
5. **Actions.** Declare every control on the card in `INBOX_ACTIONS` from the index table:
   `nudge`, `continue`, `mark-done`, `resubmit`, `push`, `stop` and `message` with spoken forms;
   `open-session` and `open-run` as click-only navigation; `dismiss` as click-only dismissal.
   The escalation's reply box and the message box both send through `message`. Draw them with
   `InboxActionButton` and add the card's file to the Phase 1 scan.
6. **Docs.** The Stuck sessions part of `docs/attention-and-alerts.md`, including that there are
   no Stuck rows while stall detection is off and that a queue-only row has no Mark done.

## 6. Data and compatibility

No storage. `facts` and `fingerprint` are additive on a polled response. With the flag off the
fold ignores stalls and alerts are unchanged.

## 7. Tests and verification

- `test/stall.test.ts`: facts for each rule, including a task with no queue, a queue with no
  task (`task` null, `queueOpen` above zero) and both; `fingerprint` equal across two times,
  different when the round or the open work changes; every pinned sentence unchanged.
- `test/attention-inbox.test.ts`: the item, its place, its count, no duplicate under Waiting on
  you, the dismissal rule.
- A `renderToStaticMarkup` test for `StuckCard`: a task stall draws Mark done; a queue-only stall
  draws Continue and Open session and no Mark done; a parked run draws Resubmit or Tell it to
  push only under their conditions.
- An HTTP test for the message route: the text, daemon authorship, the flag gate.
- `test/inbox-actions.test.ts` now scans the Stuck card and covers its ten actions.
- `e2e/specs/inbox-stuck.spec.ts`: age a fake session's clocks in the fixture database (the
  README allows setting conditions there; see `e2e/fixtures/daemon-db.ts`) so the idle rule
  fires on a session with an open task. Assert the Stuck section and its reason, that to answer
  counts it, that Continue puts the fixed text in the fake agent's conversation, that Mark done
  completes the task and the row leaves, that a row leaves when its session works again, that
  Dismiss holds across a reload, and that no button is named Cancel. A second session with an
  open queue and no task shows Continue and no Mark done.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

Each of the four rules produces a card that names its cause and offers only the actions that can
work: no card draws a control whose target is missing. A dismissed row stays dismissed until its
facts change.

## 9. Downstream handoff

Phase 6 reads the `stuck` alert that exists today and does not depend on this phase. Voice calls
the declared actions. `Stall.facts` is additive; do not rename its kinds.

## 10. Cross-phase audit record

- The source spec keyed dismissal on the sentence; plan finding 2 replaced that with the
  fingerprint. Recorded here so a reviewer does not restore the sentence.
- This phase and Phase 2 both add a kind to `INBOX_SECTION_ORDER`, a case to the inbox row
  switch and entries to `INBOX_ACTIONS`. They share no item kind or action id, so either may
  merge first.
- A session with questions open keeps its question row; only the Waiting on you backstop yields
  to a Stuck row.
- Plan validation round 1: Open session, Open run, Dismiss and the message box are now declared
  too, so the card has no undeclared control.
- Plan validation round 2: re-checked the card against the action table. The escalation's reply
  box is the `message` action; no control here was undeclared.
- Plan validation round 3: the unfinished-work facts now carry `task` and `queueOpen` separately,
  and Mark done is drawn only with a task. R16 and the index's action table say the same. No
  queue-completion route is added; that would be a new capability outside this plan.
