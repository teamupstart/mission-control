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
   - `reanchor(anchor, newText)` returning one of: unchanged, moved (with the new range), or
     `outdated`. Rules in `plan.md` under "The anchor". Pure, no I/O.
2. **All three tables in `src/server/db.ts`**, appended to the one schema template literal, in the house
   style of `inspector_comments` (`db.ts:1842-1861`): a comment block above the table stating the
   rule it enforces, aligned column types, `--` comments naming each enum domain, indices declared
   immediately beneath.
   - `file_comment_threads`, `file_comment_messages` and `file_comment_reviews`, columns exactly as
     `plan.md` specifies. The third is the walkthrough's run state - one row per session, holding
     `idle | running | paused` and the pause reason. Phase 3 is its only writer, but it is declared
     here with the others for the same reason they are: a shipped table cannot gain a column back.
   - A partial unique index on `(session_id) WHERE status IN ('sending', 'awaiting')`. Export the
     outstanding statuses as one `as const` tuple and build the predicate from it the way
     `inFlightIndexSql()` builds `one_inflight_per_queue` from `IN_FLIGHT_ITEM_STATES`
     (`db.ts:2756-2759`), so enforcement and readers cannot drift. **Both statuses, not just
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
   - **Minting `short_id`.** Creation derives the thread's `MC-xxxx` handle beside its UUID and
     stores it, unique per session. It is what the payload cites and what the transcript fallback
     matches, so it is generated once and never recomputed from the row.
   - **`markFileCommentMessageDelivered(id, at)`** stamps `delivered_at`. The column is written by
     the delivery path in phase 3, so it needs its writer declared here alongside the insert -
     otherwise it is a column with no way to stop being NULL.
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
     one function. **It refuses a row whose `delivered_at` is set**, and that refusal is the
     contract, not a nicety: once the agent has read a comment, the dashboard's copy and the
     agent's copy have to stay the same text. Editable until delivered, frozen after.
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
     (`orphaned`), the way `ReviewManager.orphanReviewsFor` (`reviews.ts:357`) does. **Not a
     `DELETE`,** and never keyed on `state === "exited"`.
   - `registry.onSessionsObserved(...)` - the same reconciliation for threads whose session vanished
     while the daemon was down, mirroring `orphanReviewsWithNoLiveSession` (`reviews.ts:362`).
     Without this arm, pre-restart rows survive forever.
   - A throttled prune of terminal rows against the live key set, in the shape of
     `pruneSessionGoals` (`db.ts:7449`) / `Registry.pruneGoals` (`registry.ts:6541`), gated on
     `sweptSessions`.
5. **Zod schemas in `src/shared/protocol.ts`** for every mutating route, in the house shape
   (`RenameArchiveSchema`, `protocol.ts:5535-5539`): doc comment, `export const XSchema`, then
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
8. **Routes in `src/server/routes.ts`**: create, list, delete, reorder, **append a message**,
   **edit an undelivered message's body**, **mark a thread read**, and **set a thread's status** - the last is what phase 2's resolve control and phase
   4's `addressed` both post to, and without it "edit" means the body only and neither can land.
   This phase owns the reorder route outright; phase 3 adds `start`/`pause`/`resume` beside it and
   does not redeclare it. `parseBody` for
   every mutating route; no hand-parsed JSON. If a manager instance is needed, append it as the
   **last** optional positional parameter of `buildApp` (currently `productIssues`, `routes.ts:859`)
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
  thorough.
- `test/file-comment-contracts.test.ts` - Zod bounds and refusals.
- `test/file-comments-store.test.ts` - SQL, status transitions, `queue_seq` rewrites, the
  `outdated` flag surviving a status change in both directions, message append and load order for
  both authors, editing an undelivered message and **being refused on a delivered one**, stamping
  `addressed_at` and `read_at` without touching `status`, and that the partial unique index refuses a second outstanding row for one session
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

- The `FileCommentAnchor` shape and `reanchor()`'s three outcomes.
- All three tables' full column shape, including the columns phases 3 and 4 are first to write:
  `queue_seq`, `delivery_id`, `answered_at`, `addressed_at`, and every column of
  `file_comment_reviews`.
- The outstanding-status tuple and the index built from it. Phase 3 enforces one turn outstanding
  on top of this, never instead of it, and never widens the tuple to make a transition easier -
  `unanswered` exists precisely so decision 3's auto-advance does not need it widened.
- `short_id` minting (creation), `markFileCommentMessageDelivered` (phase 3, at send), the
  status-setting route (phases 2 and 4), `markFileCommentThreadAddressed` (phase 4) and
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
