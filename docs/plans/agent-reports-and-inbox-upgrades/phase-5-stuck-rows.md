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
control, stall settings UI, notifications (Phase 6 adds the switch).

## 4. Repository findings and contracts

- Inherited: `INBOX_FLAG`, `agentDisplayName`, `INBOX_SECTION_ORDER`, `INBOX_ACTIONS`.
- The rules are `detectStall` (`src/shared/stall.ts:226`): `escalated`, `silent-working`,
  `unfinished-work`, `workflow-parked`. A `Stall` carries only `sessionId`, `kind`, `forMs`,
  `reason` and `workflowRunId` (`stall.ts:80`). The parked sentence is built in `parkedReason`
  (`stall.ts:186`) and includes the unpushed clause from `src/shared/unpushed.ts`.
- Stalls are computed in the away watcher (`src/server/away/watcher.ts:156`), served at
  `GET /api/away/stalls` (`src/server/routes.ts:7702`) and already polled into
  `src/web/App.tsx` through `useStalls` (`src/web/lib/stalls.ts:33`).
- Whether a parked run reopens by itself is `workflowRunResumesItself`
  (`src/shared/workflow.ts:2569`). Resubmit refuses `waiting_for_new_head` and externally sourced
  runs (`src/server/workflows/manager.ts:2237`).
- An escalation is `session.note` with `disposition === "escalated"` (`stall.ts:241`).
- Routes that exist: interrupt (`routes.ts:6884`), complete a task (`routes.ts:10032`), resubmit
  (`routes.ts:3326`), send (`routes.ts:6205`).
- A queued row is the operator's unless `daemonAuthorOf` recognises its id prefix
  (`src/server/pending-turns.ts:157`).
- Dismissal keys use `occurrenceOf` (`src/web/lib/attention.ts:318`). The backstop reads
  `represented` (`attention.ts:361`). `test/attention-pill-invariant.test.ts` pins to answer
  against need you.

## 5. Implementation steps

1. **Stall facts.** Add `facts`, discriminated by kind: `silent-working` (the activity line,
   quiet since); `unfinished-work` (whether a task or a queue is open, the task's id and title or
   the queue count); `workflow-parked` (run id, workflow name, status, round, `resubmittable`,
   `unpushedCommits`); `escalated` (the note text). Add `fingerprint`: the kind and those facts
   with every clock left out. `reason` keeps its wording.
2. **Fold.** With the flag on, each stall whose session is live becomes a `session_stuck` item
   (`stuck:<sessionId>`), placed by `INBOX_SECTION_ORDER`, counted once in `total`. Its session
   joins `represented` before the backstop runs. Its dismissal key is
   `occurrenceOf(kind, fingerprint)`, so it stays dismissed while minutes pass and returns when
   the facts change.
3. **Fixed messages.** The three texts from the source plan live in `src/shared/inbox.ts`.
   `POST /api/sessions/:id/inbox-message { kind: "nudge" | "continue" | "push" }` queues one
   with the id prefix `inbox-message:`, which `daemonAuthorOf` treats as daemon-written, so it is
   never captured as the agent's Goal.
4. **Cards.** One `StuckCard`, titled with the display name and the reason. Silent while
   working: Nudge, Interrupt. Idle with work open: what is open, Continue, Mark done. Parked run:
   the missing step, Resubmit only when `resubmittable`, Tell it to push only when
   `unpushedCommits > 0`, and Open run. Escalation: the note and a reply box that sends a normal
   operator message. Every card has a message box and Open session. A failed action shows its
   error under the row. There is no Cancel.
5. **Actions.** Declare `nudge`, `continue`, `mark-done`, `resubmit`, `push` and `stop` in
   `INBOX_ACTIONS` with their spoken forms, and place the hints.
6. **Docs.** The Stuck sessions part of `docs/attention-and-alerts.md`, including that there are
   no Stuck rows while stall detection is off.

## 6. Data and compatibility

No storage. `facts` and `fingerprint` are additive on a polled response. With the flag off the
fold ignores stalls and alerts are unchanged.

## 7. Tests and verification

- `test/stall.test.ts`: facts for each rule; `fingerprint` equal across two times, different
  when the round or the open work changes; every pinned sentence unchanged.
- `test/attention-inbox.test.ts`: the item, its place, its count, no duplicate under Waiting on
  you, the dismissal rule.
- An HTTP test for the message route: the text, daemon authorship, the flag gate.
- `e2e/specs/inbox-stuck.spec.ts`: age a fake session's clocks in the fixture database (the
  README allows setting conditions there; see `e2e/fixtures/daemon-db.ts`) so the idle rule
  fires. Assert the Stuck section and its reason, that to answer counts it, that Continue puts
  the fixed text in the fake agent's conversation, that the row leaves when the session works
  again, that Dismiss holds across a reload, and that no button is named Cancel.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

Each of the four rules produces a card that names its cause and offers only the actions that can
work. A dismissed row stays dismissed until its facts change.

## 9. Downstream handoff

Phase 6 reads the `stuck` alert that exists today and does not depend on this phase. Voice calls
the declared actions. `Stall.facts` is additive; do not rename its kinds.

## 10. Cross-phase audit record

- The source spec keyed dismissal on the sentence; plan finding 2 replaced that with the
  fingerprint. Recorded here so a reviewer does not restore the sentence.
- This phase and Phase 2 both add a kind to `INBOX_SECTION_ORDER` and a case to the inbox row
  switch. They do not share an item kind, so either may merge first.
- A session with questions open keeps its question row; only the Waiting on you backstop yields
  to a Stuck row.
