# Phase 1: Anchor, durable model, and wire

## Outcome

Mission Control can durably hold a line-anchored comment thread, re-anchor it when the file moves
under it, and tell every dashboard about it - with a route suite that proves all of it. No UI. The
next phase draws a gutter against a contract that is already settled and already tested.

The engineering value is specific: after this merges, the anchor type and the table shape are fixed,
and three renderer integrations can be written against them without any of the three being able to
change them cheaply. That ordering is deliberate - see the entry on `addColumn` below.

## Entry criteria and dependencies

- Direct prerequisites: none. Base is current `main`.
- Read `docs/agent-guides/change-contracts.md` before starting. This phase triggers three of its
  checklists at once (new persisted entity, new `ServerEvent`, new mutating routes).

## Scope

1. **`src/shared/file-comment-anchor.ts`** - the pure anchor module. Browser-safe, **no `node:`
   imports** (`src/shared/` is a controlled path). Owns:
   - the `FileCommentAnchor` shape: `path`, `startLine`, `endLine`, `quote`, `quoteHash`,
     `revision`, `surface`;
   - `quoteHash` = `sha256(path + "\n" + normalized quote)`, excluding the line numbers, exactly as
     `fingerprint()` (`src/server/inspector/marker.ts:140-148`) excludes them. Use Web Crypto or a
     small local digest rather than `node:crypto`, which this directory forbids;
   - `reanchor(anchor, newText, revision)`, where `revision` is the revision of `newText`,
     returning one of: unchanged, moved (with the new range), or `outdated`. Rules in `plan.md`
     under "The anchor". Pure, no I/O.
   - **Still exactly three outcomes.** The revision rides on the outcome rather than adding a
     fourth: a successful re-anchor carries it out so the caller can persist it, and `outdated`
     does not advance it. **The revision is an argument, not something the caller resolves
     afterwards**, because the "revision unchanged" rule is what decides whether the quote is
     searched for at all - drop it from the signature and that rule cannot be evaluated, so every
     send rescans the whole file.
2. **All three tables in `src/server/db.ts`**, appended to the one schema template literal, in the house
   style of `inspector_comments` (`db.ts:1837-1859`): a comment block above the table stating the
   rule it enforces, aligned column types, `--` comments naming each enum domain, indices declared
   immediately beneath.
   - `file_comment_threads`, `file_comment_messages` and `file_comment_reviews`, columns exactly as
     `plan.md` specifies. The third is the walkthrough's run state - one row per session, holding
     `idle | running | paused` and the pause reason. Phase 3 is its only writer, but it is declared
     here with the others for the same reason they are: a shipped table cannot gain a column back.
   - A partial unique index on `(session_id) WHERE status IN ('sending', 'awaiting')`. Export the
     outstanding statuses as one `as const` tuple and build the predicate from it the way
     `inFlightIndexSql()` builds `one_inflight_per_queue` from `IN_FLIGHT_ITEM_STATES`
     (`db.ts:2754-2761`), so enforcement and readers cannot drift. **Both statuses, not just
     `sending`:** a comment is outstanding until the agent answers it, and `awaiting` is the longer
     half of that window. An index over `sending` alone would let a second start or a resume open a
     new delivery while the first comment is still unanswered - the exact failure one-at-a-time
     exists to prevent, and the reason this is an index rather than a check in the manager.
   - **Declare the whole shape now**, including `delivery_id`, `answered_at`, `addressed_at`,
     `read_at` and every column of `file_comment_reviews` - columns phases 2, 3 and 4 are the first
     to write. (`queue_seq` is phase 2's: a comment joins the review the moment it is submitted,
     which is what "comments accumulate as an ordered review queue" means. Phase 3 reorders and
     drains a queue phase 2 fills.) A shipped table cannot gain a column from the CREATE
     TABLE alone; it needs `addColumn` in `migrate()` forever after (`db.ts:3077-3079`).
   - **No `migrate()` entry is needed** for a new table: the schema literal runs on every open,
     before `migrate()`.
3. **Store functions in `db.ts`**, Shape A (module-level exported functions, as
   `upsertInspectorComment` / `loadInspectorComments` are): create, list by session, list by session
   and path, delete, reorder `queue_seq`, set and clear the `outdated` flag, read and write the
   review's run state, and the status transitions.
   - **`queueFileCommentThread(threadId, now)` places a thread at the tail of its session's queue**
     in one call: sets the status to `queued` **and** allocates its `queue_seq` as
     `COALESCE(MAX(queue_seq), -1) + 1` scoped to the session.
     - **It is the only way a thread enters the queue, first time or not.** Three paths need it and
       they are the same operation: phase 2 submitting a `draft`, a human follow-up on an
       `answered` or `unanswered` thread, and phase 3 requeueing a thread whose turn resolved with
       undelivered human messages left. Declaring it once is what stops the second and third being
       improvised out of the generic status route, which cannot allocate a position at all.
     - **A fresh tail number every time; the prior `queue_seq` is discarded, never reused.**
       Reusing it would put a follow-up back in the original comment's old position, ahead of
       comments the human queued in between - "re-enters the queue **at the end**" is the contract
       in `plan.md`, and reuse quietly breaks it.
     - **The accepted source statuses are exactly `draft`, `answered` and `unanswered`** - an
       allow-list, not "anything that is not outstanding". Everything else is refused, for two
       different reasons worth keeping apart:
       - **`sending` and `awaiting`** are outstanding. Pulling a thread out of that set while its
         turn is live in `pending_turns` would empty the set the single-flight index is built on.
       - **`resolved` and `orphaned`** are terminal. Requeueing a `resolved` thread would reopen
         something a person closed, contradicting `plan.md`'s "only a person closes it" and the
         rule that a late agent reply leaves a resolved thread alone; requeueing an `orphaned` one
         would allocate a queue position in a session that no longer exists. **A person who wants a
         resolved thread back in the review un-resolves it through the status route first** - that
         is a deliberate act by the only party allowed to perform it, and the ordinary requeue then
         applies. The two-step is the point, not an inconvenience.
       The guard belongs on the operation rather than being restated at each of its three callers,
       and the route is exposed, so it has to hold against a caller that is not one of them. Model it on `createPendingTurn`
     (`db.ts:8689`), which allocates `pending_turns.seq` exactly this way inside one
     `BEGIN IMMEDIATE` (`db.ts:8699` is the allocating select) - the house style every transaction
     in this file follows (`db.ts:516`).
   - **It has to be one operation, and the reason is not the one it looks like.** `DatabaseSync` is
     fully synchronous and the daemon is the only writer, so the select and the update cannot
     interleave *inside* one store function - that part is safe for free. The hazard is composing
     it out of the generic status route plus the reorder route, which is **two HTTP requests**, and
     another submit can land between them and allocate the same number. The race is created by the
     missing operation, not by SQLite, which is why the fix is to declare the operation rather than
     to add locking.
   - **No `UNIQUE` index on `(session_id, queue_seq)`, deliberately.** The closest analogue that
     also reorders is `foreman_queue_items`, which has none, because a full rewrite passes through
     states where two rows share a seq - see the two-pass scratch offset and its comment at
     `db.ts:9593-9598`. `pending_turns` can afford `idx_pending_turns_order` (`db.ts:1738`) only
     because it never reorders. Ours does, so it follows `foreman_queue_items`. This is recorded so
     a later change does not "fix" the missing index and break the reorder route.
   - The reorder route rewrites with that same **two-pass scratch offset**, so the list never
     passes through an ambiguous order for anything reading mid-transaction.
   - **Minting `short_id`.** Creation derives the thread's `MC-xxxx` handle beside its UUID and
     stores it, unique per session. It is what the payload cites, what phase 4's reply tool takes
     as its `commentId`, and what the transcript fallback matches - so it is generated once and
     never recomputed from the row. **Unique per session means every lookup by `short_id` is
     session-scoped**; it is not a global key, and resolving one without a session would let a
     reply land on another session's thread.
   - **Minting is collision-safe, and the unique index is the authority.** `MC-` plus four hex
     characters is 65,536 handles per session, so by the birthday bound a session is around a 1%
     collision risk at ~36 comments and roughly even odds at ~300. A review is normally tens of
     comments, so the first candidate nearly always wins - the loop exists for the tail, not the
     common case, and the width is recorded here as a decision rather than left to look accidental.
     - **Attempt the insert and inspect the failure; never pre-check with a `SELECT`.** A
       read-then-write races another create in the same session, and it is the natural wrong fix.
       Copy `isSingleFlightViolation` (`queue.ts:400-403`), which matches **one named index** by
       regex so an unrelated constraint failure is not swallowed as a collision.
     - On a collision, mint again and retry, bounded. **If the bounded loop is exhausted, widen the
       handle rather than fail**: the column is `TEXT` and the transcript fallback matches it out
       of free text, so a longer id costs nothing and is still quotable. Thread creation must not
       be the thing that fails - refusing to save a comment a human just wrote is a far worse
       outcome than an id two characters longer.
     - Minting happens inside the same transaction as the thread insert, so a retry cannot leave a
       half-created thread behind.
   - **`beginFileCommentDelivery(threadId, deliveryId, deliveryRevision)`** moves a thread
     `queued` → `sending` and records the correlation in `delivery_id`. This is the write phase 3
     performs when it *submits*, and it deliberately does **not** stamp `delivered_at`:
     `pendingTurns.submit()` only enqueues a turn (`delivery: "pending"`, `submitVerified: false`),
     so from here the thread is outstanding but not yet delivered.
     - **It is also the re-point.** Valid from `queued` for a first send, and from `sending` when
       an `uncertain` delivery is being retried and the correlation is being replaced - phase 3's
       recovery path. It refuses every other status. The single-flight index is unaffected by the
       retry case, since `sending` is outstanding both before and after; re-pointing through this
       function rather than a second writer is what keeps `delivery_id` to one declared writer. It is also where the partial
     unique index bites, which is the point - the index refuses a second `sending` row for the
     session rather than trusting phase 3's bookkeeping.
   - **`markFileCommentMessageDelivered(id, at)`** stamps `delivered_at` and completes that
     transition, `sending` → `awaiting`. Phase 3 calls it from the **confirmed-delivery** signal -
     the one the two sites that retire a claimed row already raise (`pending-turns.ts:671`, `:914`,
     both via `journalDelivered`) - and never at submit. Stamping at submit would mark a comment
     delivered while it was still queued in the outbox, where it can still be recalled, dropped, or
     turned `uncertain` by a restart.
   - **`updateFileCommentThreadAnchor(threadId, { startLine, endLine, revision, outdated })`** is
     what makes the re-anchor pass durable. `reanchor()` is pure and only returns an outcome, so
     without a writer a thread that moved would be recomputed from its original anchor on every
     send and `revision` could never leave the value creation gave it. Phase 3 calls this once per
     comment in its re-anchor pass; it is the only writer of `start_line`, `end_line`, `revision`
     and `outdated` after creation. It **changes no status** - `outdated` is a flag beside the
     status, and whether to hold a comment at the head of the queue is phase 3's decision, not this
     function's.
   - **`markFileCommentThreadAddressed(threadId, at)`** stamps `addressed_at` and **changes no
     status**. `addressed` is deliberately not a status - only a person closes a thread - so it
     cannot ride the status route, which would have to move the thread somewhere to write anything.
     Phase 4's reply route calls this in the same transaction as the reply insert, so a thread is
     never seen as addressed by a reply that failed to persist.
   - **`markFileCommentMessagesRead(threadId, at)`** stamps `read_at` on that thread's unread
     agent messages. The Files tab pip counts messages where it is NULL, so this is what clears it.
   - **`updateFileCommentMessageBody(id, body)`, and the rule that governs it.** The comment text
     lives in `file_comment_messages`, not on the thread, so this is the only way any comment body
     is edited - phase 2's drafts-from-the-first-keystroke and phase 3's edit-unsent are both this
     one function. **It refuses a row whose `delivered_at` is set, and also one whose thread is
     outstanding** - reuse the same exported tuple the partial unique index is built from, rather
     than spelling the statuses again. That refusal is the contract, not a nicety: once a comment's
     bytes are committed to the outbox the dashboard's copy and the agent's copy have to stay the
     same text. **Both halves are needed.** They are two different moments: submitting only queues
     a turn, so a comment sits in `pending_turns.text` while its thread is `sending` and before
     `delivered_at` exists. Refusing on `delivered_at` alone leaves that window editable, and an
     edit inside it changes the dashboard's copy of a comment already committed to the outbox.
   - **`file_comment_messages` gets its writer here too.** `appendFileCommentMessage(threadId,
     author, body)` is the only insert - **thread creation calls it** for the opening message
     rather than writing a row of its own, so there is one insert path and not two that can drift.
     A thread's messages load with it. The `author` column is why one function serves both writers:
     phase 2's reply box passes `human`, phase 4's MCP tool passes `agent`, and neither invents a
     second insert. Without it phase 2 would ship a reply box with nothing behind it, or reopen
     this phase's already-merged store contract to add one.
4. **A `FileCommentManager`** owning the session-scoped lifetime. This is the part the source plan
   got wrong; implement the repository's actual pattern, which is **three mechanisms**:
   - `registry.subscribe` on `session_remove` - mark that session's threads terminal
     (`orphaned`), the way `ReviewManager.orphanReviewsFor` (`reviews.ts:439`) does. **Not a
     `DELETE`,** and never keyed on `state === "exited"`.
   - `registry.onSessionsObserved(...)` - the same reconciliation for threads whose session vanished
     while the daemon was down, mirroring `orphanReviewsWithNoLiveSession` (`reviews.ts:444`).
     Without this arm, pre-restart rows survive forever.
   - A throttled prune of terminal rows against the live key set, in the shape of
     `pruneSessionGoals` (`db.ts:7560`) / `Registry.pruneGoals` (`registry.ts:6541`), gated on
     `sweptSessions`.
5. **Zod schemas in `src/shared/protocol.ts`** for every mutating route, in the house shape
   (`RenameArchiveSchema`, `protocol.ts:5605-5609`): doc comment, `export const XSchema`, then
   `export type X = z.infer<typeof XSchema>` immediately after. Bound every string.
6. **Wire types in `src/shared/types.ts`**: the `FileCommentThread` entity **carrying its messages
   in time order** - phase 2 renders a thread from one frame and phase 4 delivers a reply through
   one, so a thread that arrives without its messages needs a second fetch neither phase has - and
   two `ServerEvent` arms named to the existing convention: `file_comment_thread_upsert` (carrying
   the thread) and `file_comment_thread_remove` (carrying `id`). **Bound the message list** in the
   doc comment the way the collection bound is stated, and say what happens past it; a thread with
   an unbounded reply history rides every snapshot.
7. **`src/server/registry.ts`**: the collection on `snapshot()`, the emit helpers, and an
   **explicit decision on `LINE_INPUT_EVENTS`** (`registry.ts:431`) with the reason written beside
   it. The recommendation is **absent** - the Line strip does not read file comments - and
   `pipeline_upsert`'s deliberate absence is the precedent to follow.
8. **Routes in `src/server/routes.ts`**: create, list, delete, reorder, **queue a thread**
   (the `queueFileCommentThread` pair above - phase 2 calls this one route rather than composing
   the status and reorder routes), **append a message**,
   **edit an undelivered message's body**, **mark a thread read**, and **set a thread's status** -
   the last is what phase 2's resolve control posts to, and without it "edit" means the body only
   and resolving cannot land.
   - **`addressed` does not go through the status route, and gets no route here.** It is
     `markFileCommentThreadAddressed` above, called inside phase 4's own reply route in the same
     transaction as the insert. Nothing in the dashboard sets it - only an agent does - so there is
     nothing here to expose. Routing it through the status route would force a status transition in
     order to write a timestamp, which is exactly how an agent's suggestion becomes a closure.
   This phase owns the reorder route outright; phase 3 adds `start`/`pause`/`resume` beside it and
   does not redeclare it. `parseBody` for
   every mutating route; no hand-parsed JSON. If a manager instance is needed, append it as the
   **last** optional positional parameter of `buildApp` (currently `productIssues`, `routes.ts:860`)
   and answer **503** when absent.
9. **Browser plumbing**: the exhaustive cases in `src/web/useEventStream.ts`, the collection on
   `MissionState`, the snapshot arm with a `?? []` version-skew guard, and helpers on
   `src/web/lib/api.ts` (note the path - it is `lib/api.ts`, not `api.ts`).
10. **`docs/sqlite-database.html`**: all three tables in a family, the family's `N tables` count, **and**
    the two hand-maintained totals at `:429` (lede prose) and `:437` (metric tile).
11. **`docs/event-stream.md`**: both new event variants and what bounds the collection. They ship
    here, so they are documented here.

## Non-goals

- No UI of any kind. No toolbar control, no gutter, no thread rendering.
- No delivery. Nothing writes to a session, and `pending_turns` is not touched.
- No MCP tool.
- No `start`/`pause` walkthrough routes - phase 3 owns those.

## Repository findings this phase rests on

- The schema is one `db.exec()` literal; `migrate(d)` runs after it, not inside it. Read the file
  for the current line numbers rather than trusting one written here - `db.ts` moved ~700 lines
  during this plan's own review.
- `test/db-shell.test.ts:58` asserts `75` tables and becomes `78`. A second test in the same file
  cross-checks each family's `<span>N tables</span>` against its row count.
- No existing table is hard-`DELETE`d on `session_remove`; every subscriber orphans by UPDATE, and
  every one has an `onSessionsObserved` second arm.
- `change-contracts.md:14-28` requires the `LINE_INPUT_EVENTS` decision **and** a stated bound on the
  new collection, pinned by a test.
- `buildApp`'s optional parameters are positional and appended last because ~50 tests construct it
  that way (`routes.ts`, on `buildApp`'s trailing optional parameters).

## Data and migration notes

- Epoch-millisecond `INTEGER NOT NULL` timestamps; `TEXT PRIMARY KEY` from `randomUUID()` at the
  call site; relations by convention, not `REFERENCES`.
- Columns in a `UNIQUE` index targeted by `ON CONFLICT` must be non-null - SQLite treats nulls as
  distinct (`change-contracts.md:50-63`).
- No backticks inside the `openDb()` SQL template literal.
- **State the bound** on the threads collection in its doc comment: how many threads can ride a
  reconnect, and the fleet arithmetic. Every collection rides every snapshot.

## Verification

- `test/file-comment-anchor.test.ts` - re-anchoring: exact, moved, duplicated (nearest wins), gone,
  and reversible. Pure, so cover it exhaustively; this is the cheapest place in the feature to be
  thorough. Include the revision cases: a matching revision short-circuits without searching, a
  successful re-anchor carries the new revision out, and an `outdated` one does not.
- `test/file-comment-contracts.test.ts` - Zod bounds and refusals.
- `test/file-comments-store.test.ts` - SQL, status transitions, `queue_seq` rewrites, the
  `outdated` flag surviving a status change in both directions, **`queueFileCommentThread`
  allocating consecutive `queue_seq` values across repeated submits in one session and starting a
  second session's queue at zero, a requeue from `answered` landing at the **tail** rather than its
  old position, and the same call **refused on every status outside the allow-list** - `sending`
  and `awaiting` for the single-flight reason, `resolved` and `orphaned` because terminal is
  terminal**, message append and load order for
  both authors, editing an undelivered message and **being refused on a delivered one and on one
  whose thread is merely outstanding**, stamping
  `addressed_at` and `read_at` without touching `status`, **`short_id` minting surviving a forced
  collision** - seed a session's handle, force the next mint onto it, and assert the thread is
  created with a different handle rather than the insert failing - and that the partial unique index refuses a second outstanding row for one session
  **from either outstanding status** - a `sending` row beside an `awaiting` one, not just two
  `sending` rows. That asymmetric case is the one an index over a single status would pass.
- `test/file-comments-lifecycle.test.ts` - `session_remove` orphans; `state === "exited"` alone
  changes nothing; the `onSessionsObserved` arm settles rows orphaned during a daemon outage; the
  prune deletes only terminal rows whose session is gone.
- `test/file-comments-migration.test.ts` - the subprocess round-trip shape of
  `test/retro-followup-migration.test.ts`: drop the table in one child, re-open in a second, assert
  it returns, assert a third pass keeps it.
- `test/file-comments-http.test.ts` - every route through `buildApp()`. Remember `/api/*` is behind
  `requireLoopback`, so send `{ host: "127.0.0.1:7317" }`.
- `test/file-comments-sse.test.ts` - snapshot and incremental convergence in the shape of
  `test/pipeline-sse.test.ts`, plus its wire-size budget assertion and its
  `useEventStream.ts` source-parity checks (`case "file_comment_thread_upsert":` present,
  `const unhandled: never = msg;` still present).
- Commands: `npm run typecheck`, `npm run lint`, `npm test`.

Every test file needs the `HARNESS_HOME`-above-imports preamble and `await import(...)` for anything
under `src/`. Run one file with
`node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts`.

## Merge and exit criteria

- A thread can be created, listed, edited, reordered, resolved, replied to, marked read, marked
  addressed, and deleted through real routes, and a thread arrives on the wire with its messages
  in time order.
- `addressed_at` and `read_at` can each be written **without** the thread's status changing.
- A thread survives a daemon restart and is orphaned when its session is removed - by both arms.
- Both new event variants reach a browser, and the snapshot and the stream agree.
- The database guide catalogs all three tables and all four counts agree.
- Typecheck, lint, and the full unit suite pass.

## Downstream handoff

Later phases may rely on, and must not change:

- The `FileCommentAnchor` shape, `reanchor()`'s `(anchor, newText, revision)` signature, and its
  three outcomes.
- All three tables' full column shape, including the columns phases 3 and 4 are first to write:
  `queue_seq`, `delivery_id`, `answered_at`, `addressed_at`, and every column of
  `file_comment_reviews`.
- The outstanding-status tuple and the index built from it. Phase 3 enforces one turn outstanding
  on top of this, never instead of it, and never widens the tuple to make a transition easier -
  `unanswered` exists precisely so decision 3's auto-advance does not need it widened.
- `short_id` minting (creation), `beginFileCommentDelivery` (phase 3, at submit) and
  `markFileCommentMessageDelivered` (phase 3, on confirmed delivery - **not** at submit),
  `updateFileCommentThreadAnchor` (phase 3, re-anchor pass), the
  status-setting route (phase 2's resolve control - **not** phase 4, which never touches it),
  `markFileCommentThreadAddressed` (phase 4, from its own reply route) and
  `markFileCommentMessagesRead` (phase 4). Each has exactly one declaration here; no phase
  reimplements one, and none of them is a status change in disguise.
- `appendFileCommentMessage` and its route: the only way a message row is written, by either
  author. Phase 2 calls it with `human`, phase 4 with `agent`.
- `delivered_at` as the per-message delivery record, and `markFileCommentMessageDelivered` as its
  only writer. Phase 3 selects what to send with it (the thread's oldest human message where it is
  NULL) and stamps it on send; that is why the queue can reorder threads while still sending the
  right message from each.
- `updateFileCommentMessageBody` and its refusal on a delivered row: the only way a comment body is
  edited. Phase 2's drafts and phase 3's edit-unsent are both this function, and no later phase
  relaxes the refusal or moves the body onto the thread.
- `status` and `outdated` as two dimensions. A later phase may add neither a status value that
  means outdated nor a second flag that means orphaned.
- The three-mechanism session lifetime. No later phase adds a fourth teardown path.
- The two `ServerEvent` variants. Phases 3 and 4 emit them; neither adds a third.

Later phases own, and this phase must not pre-empt: comment eligibility per surface (phase 2),
the walkthrough state machine and payload (phase 3), the MCP tool (phase 4).

## Cross-phase audit record

- Initial authoring. The source plan's single-signal cleanup claim was replaced with the
  repository's actual three-mechanism pattern; recorded as finding 1 in `phased-plan.md`.
- The source plan's "Migration" test row was reframed: a new table needs no `migrate()` entry, so
  the migration test proves **idempotency** rather than an upgrade path.
- Review pass: three defects repaired here rather than downstream. `orphaned` was missing from the
  status domain this phase declares, while this phase's own lifetime design writes it. `outdated`
  was a status value in `plan.md` and an orthogonal reversible flag in its prose and in phase 3;
  it is now a column, because a thread that goes outdated has to keep its place in the queue.
  And the `file_comment_messages` write path existed in no phase at all, while phase 2 shipped a
  reply box and phase 4 an agent reply - both now call one function declared here. `plan.md` and
  `plan.html` carry the same two corrections.
- Second review pass, after the outstanding-status index was widened to cover `awaiting`: that
  widening broke decision 3. Auto-advancing after a grace window means sending comment 2 while
  comment 1 is still unanswered, so a timed-out thread left in `awaiting` would collide on the
  index and deadlock the queue the index exists to protect. `unanswered` is now a declared status
  outside the tuple, which is the state the plan had been describing in prose as `sent, no reply`
  and never declaring.
- Review pass: the previous round's phrasing that a message "cannot change once written" collided
  with this phase's own edit-body operation, with phase 2's drafts-from-the-first-keystroke, and
  with phase 3's edit-unsent - the body lives in `file_comment_messages`, so an immutable message
  means an uneditable draft. The rule is narrower than that and is now stated as what it protects:
  **editable until `delivered_at` is set, frozen after**, so a comment the agent has already read
  cannot be rewritten behind it. `file_comment_messages` gains `updated_at` accordingly.
- Same pass, four things consumed by later phases and declared by none: the walkthrough's run
  state (now `file_comment_reviews`), `addressed_at` for phase 4's `addressed?`, `short_id` for the
  payload's `MC-a41f` and the transcript fallback, and a writer for `delivered_at`. All are
  declared here, because a shipped table cannot gain a column from `CREATE TABLE` afterwards - the
  trap this phase already names.
- Review pass (round 11): **the anchor contract promised a column no function could write.**
  `FileCommentAnchor` carried `revision`, and `plan.md`'s very first re-anchoring rule was "revision
  unchanged" - but `reanchor(anchor, newText)` was never given the current revision, so that rule
  was unevaluable, and no store function anywhere in this phase wrote `start_line`, `end_line` or
  `revision` after creation. Phase 3's "moved (send silently)" outcome therefore had nowhere to
  land: every send would have rescanned from the original anchor and `revision` would have kept its
  creation value forever. Fixed by taking the revision as an argument and adding
  `updateFileCommentThreadAnchor` as its single writer. The three outcomes phase 5 depends on are
  unchanged - the revision rides on the outcome rather than becoming a fourth.
- Review pass (round 12): `delivery_id` was declared with no writer - the same class of gap round
  11 found on `revision`. It gained `beginFileCommentDelivery`, which is also where the split
  between submitting and delivering is recorded, because phase 3 had been stamping `delivered_at`
  at submit. The message-edit refusal widened with it: freezing on `delivered_at` alone left the
  `sending` window editable, and a comment whose bytes are already in `pending_turns.text` must not
  be rewritable. The refusal reuses the exported outstanding-status tuple rather than respelling
  the statuses.
- Review pass (round 13): `short_id`'s uniqueness scope was stated but its consequence was not.
  Unique *per session* means every lookup by it is session-scoped; phase 4 resolves a reply through
  this column, and a global lookup there would land a reply on another session's thread. Recorded
  here because the column and its uniqueness rule are this phase's.
- Review pass (round 15): `short_id` was required to be unique per session with no rule for what
  happens when a mint collides, so the natural implementation fails thread creation at the unique
  index instead of saving the comment. `MC-` plus four hex is 65,536 per session - fine for a review
  of tens of comments, and roughly even odds of a collision by ~300 - so the width is now recorded
  as a decision, minting attempts the insert and inspects the failure the way
  `isSingleFlightViolation` does rather than pre-checking with a racy `SELECT`, and an exhausted
  retry loop widens the handle rather than refusing to save a human's comment.
- Review pass (round 16): submitting a comment is two writes - `draft` → `queued` and the
  `queue_seq` allocation - and this phase declared neither together, leaving phase 2 to compose the
  generic status route with the reorder route. That is two HTTP requests, and a second submit can
  land between them and take the same number; the integrated tab and the extracted `FileWindow`
  make two concurrent submits ordinary rather than exotic. Declared as one store function and one
  route, modelled on `createPendingTurn`'s allocation. Recorded at the same time: no `UNIQUE` index
  on `(session_id, queue_seq)`, because this table reorders and `foreman_queue_items` shows why a
  reordering table cannot carry one - so a later change does not add it and break the reorder.
- Review pass (round 17): `queueFileCommentThread` had been specified as `draft` → `queued`, which
  covers only the first of its three callers. A human follow-up on an `answered` or `unanswered`
  thread and a thread requeued when its turn resolves both need the same thing - the tail of the
  queue with a fresh number - and neither could get it from a generic status update, while reusing
  the thread's old `queue_seq` would send a follow-up ahead of everything queued since. Generalised
  to a tail-append over an explicit allow-list of source statuses (narrowed again in round 19),
  with the previous round's
  "do not requeue an outstanding thread" guard moved onto the operation itself, where its three
  callers cannot each forget it.
- Review pass (round 18): the route inventory said phase 4's `addressed` posts to the status route,
  contradicting this phase's own `markFileCommentThreadAddressed` contract three bullets earlier
  ("it cannot ride the status route") and phase 4's explicit "**not** the status route". An
  implementer working from the inventory would have turned an agent's suggestion into a closure, or
  invented a status transition to carry a timestamp. The inventory now names phase 2's resolve
  control alone and states that `addressed` gets no route here at all, because nothing in the
  dashboard sets it. `phased-plan.md` already had this right, which is what made phase 1 the
  outlier rather than the source.
- Review pass (round 19): round 17 generalised this operation with the phrase "valid from any
  non-outstanding status", which quietly includes the two terminal ones. The route is exposed, so a
  caller could have reopened a thread a person had closed - contradicting `plan.md`'s "only a person
  closes it" and the round-14 rule that a late agent reply leaves a `resolved` thread alone - or
  allocated a queue position inside a session that no longer exists. Replaced with an explicit
  allow-list of `draft`, `answered` and `unanswered`, and the two refusal reasons are kept apart
  because they are different: outstanding would break the single-flight set, terminal would undo a
  human decision or queue work for a dead session. Reopening a resolved thread stays possible and
  stays deliberate: un-resolve through the status route, then requeue normally. The lesson is the
  same one round 18 recorded - "everything except X" is a weaker specification than naming what is
  allowed, because the set it admits grows every time a status is added.
