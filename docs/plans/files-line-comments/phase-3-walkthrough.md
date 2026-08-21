# Phase 3: The walkthrough

## Outcome

Press **Start review** and your comments reach the session one at a time: the first goes as its own
turn, and the next goes when the agent has finished with it. The queue stays yours while it drains -
reorder it, rewrite an unsent comment, drop one, or pause. A comment whose quoted text the agent has
since deleted is held rather than sent, and says so.

This is the phase where the feature first writes into a live agent, and the phase that produces the
measurement the plan's two 60% assumptions need.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 2**, merged. This phase consumes the threads table, the anchor
  module, `reanchor()`, and the thread UI.
- May merge in either order with **Phase 5**. Neither owns a contract the other consumes. Expect a
  textual conflict in `FileWorkspace.tsx` - this phase edits the toolbar region (`:422-444`), phase
  5 edits the renderer branch (`:446-487`).

## Scope

1. **The single-comment payload renderer**, pure, in the `src/server/workflows/feedback.ts` family:
   bounded fields, stable shape, a `payloadSha256`. Content exactly as `plan.md` specifies - path,
   line range, quoted anchor, the comment, **the position line ("Comment 3 of 12")**, and the
   closing instruction to answer only this one. The position line is not decoration: it is the
   stated mitigation for the one thing a batch does better, and an agent that knows nine more are
   coming will not restructure the document on comment three.
   Server-side so the agent's copy and the dashboard's record cannot drift; pure so it is tested
   without a session, a pane, or a database.
2. **The walkthrough state machine**, durable on the threads table rather than in memory, so a
   daemon restart resumes instead of re-sending.
3. **The re-anchor-before-send pass.** Before every send, re-anchor every unsent comment against the
   file's current bytes. Three outcomes, per `plan.md`: moved (send silently), outdated at the head
   (hold and pause with the reason), outdated further down (mark in place and carry on).
4. **Delivery, keeping exactly one turn outstanding.** Submit through the existing human outbox:
   `POST /api/sessions/:id/inject` with `origin: "human"` and `buffer: true` is intercepted at
   `routes.ts:3391-3394` into `pendingTurns.submit(session.id, text)` - a **synchronous**,
   two-argument call returning `PendingTurnSubmitResult` (`pending-turns.ts:35-42`), whose `pasted`
   is the literal `false` because a queued turn never claims to have reached a pane.
   - Never submit a second turn while one is outstanding. Depth one is what keeps tail-only recall,
     head-of-line blocking behind an `uncertain` row, and the missing correlation id from ever
     mattering.
   - `delivery_id` on the thread is that correlation. `pending_turns` gains no column.
5. **Advance signals.** In this phase there is only one: the session settles idle. Per decision 3,
   wait a grace window, mark the thread `sent, no reply`, and release the next. Phase 4 adds the
   stronger signal; the fallback stays as the floor.
6. **Refusal and pause states.** `canMessage(session)` refusing is a pause with a reason, not a lost
   comment. A send that lands in `uncertain` pauses the review and surfaces the **existing** Retry /
   Mark sent controls rather than inventing a second recovery path.
7. **Queue controls in the UI**: queue depth, Start review, Pause, reorder, edit-unsent, drop. Pause
   takes effect after the outstanding comment resolves and never recalls a delivered one.
8. **A human reply in a thread re-enters the queue** at the end, and is delivered in its turn
   exactly like a new comment. An `answered` thread that gains a human reply goes back to `queued`
   with its history intact - the `outdated` flag stays orthogonal and reversible throughout.
9. **Routes** for start, pause, resume, and reorder, each with a `parseBody` schema.
10. **A live region** announcing which comment is outstanding and how many remain, so a screen-reader
   user is not left guessing.
11. **`docs/ui.md`** and a short pointer in **`docs/work-queues.md`** saying what the review queue is
    *not*, so the two one-at-a-time mechanisms are not confused for each other.

## Non-goals

- No MCP tool and no agent-initiated reply. Phase 4.
- No Files tab pip. Phase 4.
- No preview-surface commenting. Phase 5.
- No new scheduler on the pane. Delivery goes through the existing outbox, not beside it.

## Repository findings this phase rests on

- **Do not use `/send`.** It types character by character, so every newline submits early
  (`TranscriptPanel.tsx:767-776`). A multi-line payload must arrive as one bracketed paste, which is
  `/inject`.
- **Do not hold the queue in `pending_turns`.** It gives strict one-at-a-time FIFO, but only the
  tail row is recallable (`test/pending-turn-db.test.ts:51` pins *"an older row cannot jump the
  stack"*), there is no edit and no reorder at any layer, an `uncertain` row wedges the whole queue,
  and there is no correlation id. Holding twelve comments there would remove exactly the mid-review
  steering that one-at-a-time exists to provide.
- **Do not use the Foreman work queue.** Its verifier is a mandatory model call per item; from round
  1 on `payloadFor` (`queue-machine.ts:556-558`) sends `renderFixPrompt(item)` instead of your text;
  draining fires the wrap-up trigger; Pi is unsupported.
- Two outboxes already share one pane with no arbiter, separated only by differing settle windows
  (1,500ms vs 10,000ms). Adding a third scheduler would be the first without that accidental
  separation - which is why this phase adds a *caller* of the existing outbox, not a peer to it.

## Verification

- `test/file-comment-payload.test.ts` - bounding, the position line, the id, and a stable
  `payloadSha256`.
- `test/file-comment-walkthrough.test.ts` - the advance state machine: idle fallback, hold-on-
  outdated, pause, resume, restart-resumes-without-resending, and refusal when `canMessage` is
  false. Inject `now` and the submit function; this file should need no database and no pane.
- Extend `test/file-comments-http.test.ts` for the new routes.
- `e2e/specs/file-comment-walkthrough.spec.ts` - Start review sends exactly one comment; reorder and
  pause hold; the queue depth renders.
- `e2e/specs/file-comment-outdated.spec.ts` - an edit that deletes a queued comment's quoted text
  holds it and pauses with a reason.
- Both specs: flip to the Console layout first, and spend no model tokens - the fake agent binaries
  are already redirected by `e2e/fixtures/fake-agents.ts`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.

## The measurement this phase owes

`plan.md` records two assumptions at 60% confidence, and they compound: that re-anchoring keeps most
of the queue valid while the agent edits between comments, and that an agent told "answer this one
only, 9 more follow" will not over-scope. Neither can break the feature - a held comment is still
readable and still carries its exact quote - but together they decide whether a twelve-comment
review is one unattended walkthrough or six interruptions.

**Before phase 5 is scheduled**, run a real review of at least six comments against a live session
and record how many reached the head still anchored. Put the number in the pull request. If most of
the queue is going outdated, that is a design signal about the payload's scoping instruction, not a
bug to patch in the re-anchor pass.

## Merge and exit criteria

- Start review delivers exactly one comment, and the next only after the first resolves.
- `pending_turns` never holds more than one row for the session at a time.
- Reorder, edit-unsent, drop and pause all work mid-walkthrough.
- An outdated head comment is held, not sent, and the pause names the reason.
- A daemon restart mid-walkthrough resumes without re-sending the outstanding comment.
- The measurement above is recorded in the PR.

## Downstream handoff

Phase 4 may rely on, and must not change:

- **One turn outstanding.** Phase 4 changes what *advances* the queue, never how many are in flight.
- The thread's `delivery_id` correlation and the `sending` / `awaiting` statuses.
- The idle fallback, which stays as the floor beneath phase 4's stronger signal.
- The payload renderer's shape, into which phase 4 adds only the reply instruction's tool name.

## Cross-phase audit record

- Initial authoring, after Phase 2.
- Confirmed against Phase 1 that `delivery_id`, `queue_seq` and `answered_at` were already declared
  there, so this phase adds no column and needs no `addColumn`.
- Phase 4's advance signal was checked against this phase's state machine: adding a stronger signal
  is additive, so no edit to Phase 1 or 2 is required.
