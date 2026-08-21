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
- **Phase 5 depends on this phase** and must not start before it merges - not for code, but for the
  anchor-survival measurement below. **Phase 4 depends on this phase for code** - it hooks into the
  outstanding-thread concept and the release point built here. Neither owns a contract this phase
  consumes.

## Scope

1. **The single-comment payload renderer**, pure, in the `src/server/workflows/feedback.ts` family:
   bounded fields, stable shape, a `payloadSha256`. It renders **one message**, selected as
   `plan.md` specifies: the thread's oldest human message whose `delivered_at` is NULL. Do not
   render "the thread's comment" - that is only well defined on a thread's first turn, and picking
   it is what makes a follow-up resend the original. Content as `plan.md` specifies - path, line
   range, quoted anchor, that message's body, **the thread's `short_id` followed by the delivery
   ordinal** (`MC-a41f.2` - the 1-based position of the message this turn carries among the
   thread's human messages, which is derived and needs no column), **the position line ("Comment 3
   of 12")**, and the closing instruction to answer only this one. **One deliberate difference until
   phase 4 lands:** that closing instruction asks for an answer in the next turn and names no
   tool, because `respond_to_file_comments` does not exist yet. Phase 4 substitutes the tool name
   into that single line and changes nothing else. The position line is not decoration: it is the
   stated mitigation for the one thing a batch does better, and an agent that knows nine more are
   coming will not restructure the document on comment three.
   Server-side so the agent's copy and the dashboard's record cannot drift; pure so it is tested
   without a session, a pane, or a database.
2. **The walkthrough state machine**, durable rather than in memory, so a daemon restart resumes
   instead of re-sending. Per-comment progress lives on the threads; the review's own
   `idle | running | paused` and its pause reason live in phase 1's `file_comment_reviews` row,
   because "paused" and "never started" are otherwise the same set of threads.
3. **The re-anchor-before-send pass.** Before every send, re-anchor every unsent comment against the
   file's current bytes, passing the file's current revision. Three outcomes, per `plan.md`: moved
   (send silently), outdated at the head (hold and pause with the reason), outdated further down
   (mark in place and carry on).
   - **Persist every outcome through phase 1's `updateFileCommentThreadAnchor`.** `reanchor()` is
     pure, so nothing is durable until this pass writes it; skip the write and a moved comment is
     recomputed from its original anchor on every send and `revision` never advances, which defeats
     the short-circuit the first rule exists to provide.
4. **Delivery, keeping exactly one turn outstanding.** Submit through the existing human outbox:
   `POST /api/sessions/:id/inject` with `origin: "human"` and `buffer: true` is intercepted at
   `routes.ts:3391-3394` into `pendingTurns.submit(session.id, text)` - a **synchronous**,
   two-argument call returning `PendingTurnSubmitResult` (`pending-turns.ts:35-42`), whose `pasted`
   is the literal `false` because a queued turn never claims to have reached a pane.
   - Never submit a second turn while one is outstanding. Depth one is what keeps tail-only recall,
     head-of-line blocking behind an `uncertain` row, and the missing correlation id from ever
     mattering.
   - `delivery_id` on the thread is that correlation. `pending_turns` gains no column.
   - **Submitting is not delivering, and they get separate writes.** `submit()` only creates a
     `queued` row and returns `delivery: "pending"` with `submitVerified: false`; the bytes reach
     the agent later, from the drain. So the submit write is phase 1's
     `beginFileCommentDelivery` - thread `queued` → `sending`, storing `delivery_id` and the row's
     `revision`, since every `pending_turns` mutation is revision-checked. **It does not stamp
     `delivered_at`.**
   - **`delivered_at` is stamped from the confirmed-delivery signal.** That signal already exists
     and already has a consumer: the only two sites that retire a claimed row
     (`pending-turns.ts:618` and `:861`) both call `journalDelivered` (`:877`), whose comment
     states the rule - those are the places a row "positively reached the agent" - and
     `journalScoutPrompt` is its existing subscriber. Stamping there is a second subscriber to an
     established fact, not a new mechanism. That write stamps `delivered_at` and moves the thread
     `sending` → `awaiting` together.
   - **A row leaving `pending_turns` is not proof of delivery.** `recallPendingTurn` and
     `dropQueuedPendingTurns` remove rows too, so key off the signal and never off the row's
     absence. Recalled or dropped, the thread returns to `queued`, `delivery_id` clears, and
     `delivered_at` stays NULL so the comment is editable again.
   - **A delivery that ends `uncertain` never stamps**, leaving the thread `sending` and pausing
     the review (item 6). **This is also the daemon-restart case, and it needs no separate
     design**: `recoverSendingPendingTurns` already flips every `sending` row to `uncertain` at
     startup with "Mission Control restarted during delivery; confirm before retrying." A restart
     mid-delivery therefore surfaces as a paused review awaiting one human confirmation. Stamping
     at submit would instead have recorded it as delivered, and the comment would sit frozen and
     answered-for-ever having never reached the agent.
5. **Advance signals.** In this phase there is only one: the session settles idle. Per decision 3,
   wait a grace window, move the thread from `awaiting` to `unanswered`, and release the next.
   **Moving it out of `awaiting` is not bookkeeping** - `unanswered` sits outside phase 1's
   outstanding-status tuple, so it is what lets the next comment take the turn without colliding
   on the single-flight index. Phase 4 adds the
   stronger signal; the fallback stays as the floor.
6. **Refusal and pause states**, all three `plan.md` promises: a session that cannot take a
   message, **a file that has left the checkout** (the re-anchor pass has no bytes to search, which
   is distinct from a quote that moved), and a queue with nothing left to send. Each pauses and
   says which. `canMessage(session)` refusing is a pause with a reason, not a lost
   comment. A send that lands in `uncertain` pauses the review and surfaces the **existing** Retry /
   Mark sent controls rather than inventing a second recovery path.
   - **Those controls act on `pending_turns`, so each needs a correlated write on this thread, in
     the same transaction.** Without one the thread stays `sending` - an outstanding status - and
     the partial unique index blocks every later delivery, so resolving the turn would leave the
     review permanently stuck behind a comment the human just dealt with. There are exactly two
     callbacks, and both reuse writers that already exist rather than adding a third path:
     - **Mark sent** is the human supplying the confirmation the daemon could not observe, so it
       performs the confirmed-delivery write: `markFileCommentMessageDelivered` stamps the message
       and the thread moves `sending` → `awaiting`, `delivery_id` cleared. The review resumes, and
       the grace window runs from here rather than from the original send - the agent has not been
       waiting on it.
     - **Retry** re-sends the same, still-undelivered message. `delivered_at` stays NULL and the
       thread stays `sending` - it never left the outstanding set, so the index is untouched - but
       `delivery_id` must be **re-pointed** at the new `pending_turns` row through
       `beginFileCommentDelivery`, or the thread stays correlated to a row that is gone and the
       confirmed-delivery signal for the new turn will not match it.
     - A session that dies before either is chosen needs nothing here: phase 1's `session_remove`
       arm takes the thread to `orphaned`, which is terminal, and the review pauses with no session
       to resume against.
7. **Queue controls in the UI**: queue depth, Start review, Pause, reorder, edit-unsent, drop.
   Edit-unsent is phase 1's message-edit route, which refuses a delivered row **and one whose
   thread is outstanding** - so the control is offered on queued comments and not on the one in
   flight, including during the `sending` window before delivery is confirmed. Pause
   takes effect after the outstanding comment resolves and never recalls a delivered one.
8. **A human reply in a thread re-enters the queue** at the end, and is delivered in its turn
   exactly like a new comment. **What gets sent is the reply, not the comment that opened the
   thread** - the payload always carries the thread's oldest human message with `delivered_at`
   NULL, so a requeued thread sends the message you just wrote rather than resending its first
   one. Confirmed delivery stamps `delivered_at`, which is what stops a message going twice; if further
   undelivered human messages remain when the turn resolves, the thread requeues again for the
   next one. An `answered` or `unanswered` thread that gains a human reply goes back to `queued`
   with its history intact.
   - **A reply to the outstanding thread does not requeue it.** Appending is always allowed - a
     human may answer the comment currently in flight - but the status must not move, because
     `sending` and `awaiting` are the two statuses the partial unique index is built on. Moving
     that thread to `queued` would empty the outstanding set while a turn is genuinely live in
     `pending_turns`, and the walkthrough would release the next comment on top of it, breaking the
     depth-one guarantee this phase rests on. The message simply waits, and the existing rule above
     picks it up: when the turn resolves and undelivered human messages remain, the thread requeues
     for the next one. Editing is a different question and is refused outright while outstanding.
   - **Both requeue paths go through phase 1's `queueFileCommentThread`**, which appends at the
     tail with a fresh `queue_seq` - the follow-up on an `answered` or `unanswered` thread, and the
     thread whose turn resolved with undelivered human messages still on it. Neither reuses the
     thread's old position: "at the end" is the contract, and a reused number would send the
     follow-up ahead of everything queued since. That operation accepts only `draft`, `answered`
     and `unanswered`: it refuses an outstanding thread, which is the same guard as the bullet
     above, and refuses a terminal one, so neither a resolved thread nor an orphaned one can be
     pulled back into a review. Enforced once, where it cannot be forgotten.
   The `outdated` flag is a column beside the status, so it stays orthogonal and reversible
   throughout. The reply itself is still written by phase 1's
   `appendFileCommentMessage`; what this phase adds is the requeue that follows it.
9. **Routes** for start, pause and resume, each with a `parseBody` schema. Reorder is phase 1's
   route and is reused, not redeclared.
10. **A live region** announcing which comment is outstanding and how many remain, so a screen-reader
   user is not left guessing.
11. **Finish the deep-link last mile** so the walkthrough can move the reader to the comment it is
   sending. `workspaceFileTarget` already parses `path:line`, but `App.tsx` discards `target.line`
   and nothing scrolls the viewer to it (`plan.md`, "Deep-linking to a line is half-built"). This
   phase owns it because this is the phase whose feature is incomplete without it.
12. **`docs/ui.md`** and a short pointer in **`docs/work-queues.md`** saying what the review queue is
    *not*, so the two one-at-a-time mechanisms are not confused for each other.

## Non-goals

- No MCP tool and no agent-initiated reply. Phase 4.
- No Files tab pip. Phase 4.
- No preview-surface commenting. Phase 5.
- No new scheduler on the pane. Delivery goes through the existing outbox, not beside it.

## Repository findings this phase rests on

- **Do not use `/send`.** It types character by character, so every newline submits early
  (`TranscriptPanel.tsx:759-766`). A multi-line payload must arrive as one bracketed paste, which is
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
- `test/file-comment-uncertain-recovery.test.ts` - Mark sent stamps the message and moves the
  thread `sending` → `awaiting` so the review resumes; Retry leaves `delivered_at` NULL and
  re-points `delivery_id`; and after either, the partial unique index permits the next delivery.
  The failure this covers is a deadlock, not a wrong value, so assert the *next* comment goes.
- `test/file-comment-walkthrough.test.ts` - the advance state machine: idle fallback, hold-on-
  outdated, pause, resume, restart-resumes-without-resending, **reply-after-answer delivers the
  reply rather than the opening comment**, and refusal when `canMessage` is
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

Run a real review of at least six comments against a live session and record how many reached the
head still anchored. **Put the number in this phase's pull request.** If most of the queue is going
outdated, that is a design signal about the payload's scoping instruction - which this phase owns -
and not a bug to patch in the re-anchor pass.

**Phase 5 is sequenced behind this phase to make that a real checkpoint.** It needs no code from
here; it waits on this number, because preview anchors quote whole blocks and are therefore more
exposed to the same failure than the editor anchors measured here. A missing number is the same
signal as a poor one: phase 5 should not start until this is written down.

## Merge and exit criteria

- Start review delivers exactly one comment, and the next only after the first resolves.
- `pending_turns` never holds more than one row for the session at a time.
- Reorder, edit-unsent, drop and pause all work mid-walkthrough.
- A thread that is answered, then replied to, delivers **the reply** on its next turn. Cover this
  explicitly: resending the opening comment is the failure it is easiest to ship.
- An outdated head comment is held, not sent, and the pause names the reason.
- A daemon restart mid-walkthrough resumes without re-sending the outstanding comment.
- The measurement above is recorded in the PR.

## Downstream handoff

Phase 4 may rely on, and must not change:

- **One turn outstanding.** Phase 4 changes what *advances* the queue, never how many are in flight.
- The thread's `delivery_id` correlation and the `sending` / `awaiting` statuses.
- The idle fallback, which stays as the floor beneath phase 4's stronger signal.
- The payload renderer's shape, into which phase 4 adds only the reply instruction's tool name.
- The delivery selection rule: the thread's oldest human message with `delivered_at` NULL. Phase 4
  changes what advances the queue, never what a turn carries.
- The recorded anchor-survival number. Phase 5 reads it before it starts and does not re-take it.

## Cross-phase audit record

- Initial authoring, after Phase 2.
- Confirmed against Phase 1 that `delivery_id`, `queue_seq` and `answered_at` were already declared
  there, so this phase adds no column and needs no `addColumn`.
- Phase 4's advance signal was checked against this phase's state machine: adding a stronger signal
  is additive, so no edit to Phase 1 or 2 is required.
- Review pass (round 11): the re-anchor pass named three outcomes but never persisted any of them.
  Phase 1 gained `updateFileCommentThreadAnchor` and this pass now calls it once per comment, and
  passes the file's current revision into `reanchor()` so the "revision unchanged" short-circuit
  can actually fire.
- Review pass (round 12): **this phase stamped `delivered_at` at submit, and submitting is not
  delivering.** `pendingTurns.submit()` only creates a `queued` row - it returns
  `delivery: "pending"` with `submitVerified: false`, and the bytes reach the agent later from the
  drain, where the attempt can still end `uncertain`, be recalled, be dropped, or be caught by a
  restart. Stamping at submit would have frozen a comment and recorded it as delivered when the
  agent may never have seen it. Split into two writes: `beginFileCommentDelivery` at submit
  (`queued` → `sending`, storing `delivery_id`) and `markFileCommentMessageDelivered` on the
  confirmed-delivery signal (`sending` → `awaiting`). The signal is the one `journalDelivered`
  already raises at the only two sites that retire a claimed row, so this is a second subscriber to
  an established fact rather than a new mechanism. The restart case needed no new design:
  `recoverSendingPendingTurns` already turns every in-flight row `uncertain`, which lands on this
  phase's existing pause-and-confirm path.
- Review pass (round 14): this phase's requeue rule (item 8) turned out to be clobberable by phase
  4's reply handler, which moved any replied-to thread to `answered` unconditionally. Fixed in
  phase 4 rather than here - the requeue is correct, the transition that overwrote it was not - but
  recorded here because the invariant that a requeued thread keeps its `queue_seq` until its
  follow-up is delivered is this phase's to defend.
- Self-audit after round 14, looking for the same defect class rather than waiting for it to be
  reported: **the requeue-on-human-reply rule was unscoped**, in this item and in `plan.md`'s
  contract 12. The lifecycle diagram only ever drew the arrow from `answered` and `unanswered`, but
  the prose said "a human reply in a thread re-enters the queue" with no qualification, and nothing
  stops a human replying to the comment currently in flight. Applied literally that moves a
  `sending` or `awaiting` thread to `queued`, emptying the outstanding set the partial unique index
  is built on while a turn is still live in `pending_turns` - so the walkthrough would release the
  next comment on top of it and the depth-one guarantee would be gone. Appending still always
  works; the status now stays put, and the existing "requeues when the turn resolves" rule picks
  the message up.
- Review pass (round 21): the `uncertain` pause deferred to the existing Retry / Mark sent controls
  without saying what they do to *this* thread. They act on `pending_turns` only, so Mark sent would
  have resolved the turn and left the thread `sending` - outstanding, indexed, and blocking every
  later delivery - while Retry would have left `delivery_id` pointing at a row that no longer
  exists, so the confirmed-delivery signal for the new turn would never match. Both callbacks now
  have their correlated thread writes stated, reusing `markFileCommentMessageDelivered` and
  `beginFileCommentDelivery` rather than adding a third recovery path.
