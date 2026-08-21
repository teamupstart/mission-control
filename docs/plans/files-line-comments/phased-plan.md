# Line comments in the Files workspace - phased implementation

Implementation index for [`plan.md`](./plan.md), approved 2026-08-21 with all five decisions
resolved. Five phases; four merge serially and the last runs concurrently with phase 4.

## Incorporated decisions

| Decision | Resolution |
|---|---|
| Viewer surfaces in v1 | **Editor + Markdown Preview + HTML Preview** |
| Thread lifetime | **The session.** Threads end with the session that owns them |
| Agent never answers | **Auto-advance after a grace window**, marking the thread unanswered |
| Delivery | **One comment at a time**, not one batch |
| Agent's reply | **A new MCP tool**, with a transcript-id fallback |

## Investigated findings that shaped the phases

Each of these contradicts or materially extends the source plan. They are the reason the phase
boundaries are where they are.

1. **The plan's cleanup design did not match anything in this repository** (since corrected in
   `plan.md` itself). It said both tables
   are "cleared on `session_remove` and on no other signal." No table works that way. Every
   durable `session_remove` subscriber *orphans or settles by UPDATE* - `orphanReviewsFor`
   (`reviews.ts:357`), `reconcileTasksBoundTo` (`tasks.ts:1357`), `orphanBinding`
   (`workflows/manager.ts:616`). Row deletion is a separate, throttled sweep against the live key
   set (`pruneSessionGoals` `db.ts:7449`, `pruneDeadQueues` `db.ts:9265`), gated on
   `sweptSessions` because absence is not evidence before the first completed sweep. And every
   subscriber has a **second arm** - `registry.onSessionsObserved(...)` running
   `orphanReviewsWithNoLiveSession` (`reviews.ts:362`) / `reconcileTasksWithNoLiveSession`
   (`tasks.ts:1364`) - for the daemon-was-down case. Session-scoped cleanup is therefore three
   mechanisms, not one. Phase 1 owns all three.
2. **A new table needs no `migrate()` entry.** The whole schema is one `db.exec()` template
   literal (`db.ts:533-2741`) that runs on every open, before `migrate(d)` at `db.ts:2743`. The
   most recent table addition (`task_worktree_retention`, #687) added zero lines to `migrate()`.
   The corollary is the trap: once the table ships, a later column needs `addColumn` **as well as**
   the CREATE TABLE edit, so phase 1 declares the full shape up front - the house preference,
   stated at `db.ts`, beside `task_worktree_retention`.
3. **The table count lives in four places and only two are enforced.**
   `test/db-shell.test.ts:58` (`75`, becomes `78`) and the per-family `<span>N tables</span>` are
   tested; `sqlite-database.html:429` (lede prose) and `:437` (metric tile) are hand-maintained and
   drift silently.
4. **`previewable` does not mean "can take a comment"** - it includes `image`
   (`FileWorkspace.tsx:126-128`). It also cannot be redefined:
   `test/console-arrow-scroll.test.ts:41-42` asserts a **literal source regex** over that
   expression. Comment eligibility needs its own predicate.
5. **A bare key cannot open a composer from inside the editor.** The Files keydown handler bails on
   `isTypingTarget` (`FileWorkspace.tsx:141`), and that helper returns true for anything
   `contentEditable` (`keybindings.ts:462`) - which is CodeMirror's `.cm-content`. In-editor
   comment creation must be a CodeMirror **keymap** binding. The window chord only toggles the mode.
6. **The natural `c` chord is the global Complete-task action** (`docs/ui.md:783`). Shadowing a
   global in-surface is established precedent - `p` (Focus pane) and `e` (Open reviews) are both
   already shadowed, and `docs/ui.md:802-804` states the rule - but Complete is a heavier action to
   shadow. Phase 2 owns that choice; `m` is the alternative.
7. **The MCP tool name must be a bare string literal inside `registerTool(`.**
   `test/mission-mcp.test.ts:125-133` scrapes `/registerTool\(\s*"([a-z_]+)"/g` and asserts sorted
   set equality against `MISSION_MCP_TOOLS`. A named constant at the call site breaks the scrape.
8. **A tool that is not rebuilt never reaches an agent.** Sessions run the gitignored
   `dist/mcp/server.mjs`; only `npm run build` refreshes it (`change-contracts.md:46`). `npm run
   smoke` performs a real `initialize` + `tools/list` handshake and is what catches it.
9. **`LINE_INPUT_EVENTS` (`registry.ts:431`) is a hand-maintained `Set` literal the compiler cannot
   check.** `change-contracts.md:14-28` requires an explicit decision, plus a stated bound on any
   new collection, pinned by a test in the shape of `test/pipeline-sse.test.ts`.
10. **The Files tab exists only in the Console layout.** Every spec must
    `PUT /api/ui/config {"layout":"console"}` and reload before the tab exists
    (`e2e/specs/file-default-view.spec.ts:88-99`). There is no shared `dispatch()` fixture - about
    40 specs carry their own copy.
11. **A new `buildApp` dependency is appended as the last optional positional parameter**
    (`routes.ts:770-859`), because ~50 focused tests construct it positionally; its routes answer
    **503** when it is absent rather than constructing a twin.
12. **`Markdown` has a memo comparator.** A new prop absent from `markdownPropsEqual`
    (`Markdown.tsx:242-251`) is silently ignored.
13. **The HTML preview hash test hard-codes the script count** (`test/html-preview.test.ts:25`,
    `assert.equal(scripts.length, 2)`) and extracts with `/<script>([^<]+)<\/script>/g`, so a third
    bridge must update the count and contain **no literal `<`**.

## Sizing

Estimated **3,600 to 4,700 gross non-test implementation lines**, counting shared contracts,
persistence, server, MCP, and browser code together. Assumptions: the anchor module is pure and
compact; the three renderer integrations do not share code beyond the anchor type; `styles.css`
additions are counted; documentation and tests are excluded from the number but not from the work.

**Why five phases and not fewer.** The total is an order of magnitude past the 200-line one-phase
threshold, so the question is only where to cut. Each boundary below is justified by a merge
boundary that materially reduces risk, not by layer:

- **1 → 2.** Phase 1 is durable state whose shape is expensive to change after it ships (finding 2:
  a shipped table needs `addColumn` forever after). Landing it against a route suite, before three
  renderers depend on its anchor type, is what makes the type cheap to correct.
- **2 → 3.** Phase 2 ends with comments that persist and render but never send. That is the last
  point at which the feature touches no live agent. Combining it with delivery would put the first
  write into a running session in the same PR as the first gutter pixel.
- **3 → 4.** Phase 3 is a server state machine; phase 4 is an agent-facing tool with a build
  obligation whose failure mode is silent (findings 7 and 8). They fail differently and are
  verified differently.
- **3 → 5.** Phase 5 is the only work that touches the shared HTML preview sandbox, a controlled
  security module also used by Scouts, so it is worth reviewing on its own and it blocks nothing.
  It could stand on phase 2's contracts alone; it waits on phase 3 for the anchor-survival
  measurement rather than for code, which is argued under the dependency graph below.

**Phase 1 is the largest, and it grew during review.** It began at roughly 1,100-1,400 lines
against two tables; eighteen review rounds added a third table, fourteen columns, eight store
functions and five routes, so budget **1,800 to 2,300**. The last nine rounds added no columns at
all - they added *writers* for columns that already existed, and guards on them, which is a
different and cheaper kind of growth than the first eight. The growth was not scope creep - every
addition was a column or a call some later phase already consumed and no phase declared - but the
implementing agent should know it is walking into the biggest phase in the plan, not the estimate
written before review.

It is still not split at the store/route seam: that produces two pull requests each unreviewable
without the other. **If it does prove too large, the cheap cut is `file_comment_reviews`**, which
only phase 3 writes. Phase 1's "declare the whole shape now" rule is about *columns*, since a
shipped table cannot gain one from `CREATE TABLE` alone - it says nothing about which phase
introduces a *table*, and a new table needs no `migrate()` entry at all. Moving that one table and
its run-state store functions into phase 3 costs nothing structurally; it only splits the database
guide edit and the table count across two commits, which is why it is offered as a lever rather
than taken here.

That coupling is worth stating plainly for whoever implements this: across eighteen review rounds,
**seven findings were caused by a previous round's fix** - and three of those seven landed in the
last four rounds, so the rate did not decay as the plan settled. Phase 1's invariants - the
outstanding-status tuple, `delivered_at` doing three jobs, status versus flag versus timestamp -
are tight enough that changing one sentence reliably breaks a neighbour. Change them deliberately,
and re-read the cross-phase contracts below before you do.

Two failure shapes account for nearly all of them, and both are worth carrying into the
implementation rather than rediscovering:

- **A value the design relies on that nothing supplies or writes.** A `revision` no caller could
  pass, a `delivery_id` with no writer, a `commentId` the agent is never shown, a `queue_seq` no
  operation allocates. Each read as complete prose and could not be built. When a phase names a
  column or an argument, find the line that writes it before believing it exists.
- **A rule stated unconditionally that has a reachable state where it must not apply.** "A human
  reply re-enters the queue", "the thread moves to `answered`", "valid from any non-outstanding
  status". Each was true in the case it was written for. Prefer naming the states a rule applies
  to over excluding the ones it does not: "everything except X" silently grows every time a status
  is added, and this plan added two mid-review.

## Phases

| # | Phase | File | Direct prerequisites |
|---|---|---|---|
| 1 | Anchor, durable model, and wire | [`phase-1-anchor-and-model.md`](./phase-1-anchor-and-model.md) | - |
| 2 | Comment mode in the Editor | [`phase-2-editor-comment-mode.md`](./phase-2-editor-comment-mode.md) | Phase 1 |
| 3 | The walkthrough | [`phase-3-walkthrough.md`](./phase-3-walkthrough.md) | Phase 2 |
| 4 | The agent's reply | [`phase-4-agent-reply.md`](./phase-4-agent-reply.md) | Phase 3 |
| 5 | Preview surfaces | [`phase-5-preview-surfaces.md`](./phase-5-preview-surfaces.md) | Phase 3 |

## Dependency graph and concurrency

```
Phase 1 ──> Phase 2 ──> Phase 3 ──┬──> Phase 4
                                  └──> Phase 5
```

**One concurrency group: phases 4 and 5.** Neither consumes a contract the other owns, and they do
not even collide textually: phase 4 edits `detailTabs.ts` and the MCP server, phase 5 edits
`Markdown.tsx`, `htmlPreview.ts` and `FileWorkspace.tsx`'s renderer branch. They can merge in either
order, and phase 5 must not build on the reply tool or the pip, because it may land first.

**Phase 5 depends on phase 3, not on phase 2.** Phase 5 needs nothing from phase 3's code - it
reuses phase 2's components - but phase 3 is where the anchor-survival measurement is taken, and
that measurement is what says whether anchoring more of the document is worth doing. Preview
anchors quote whole blocks rather than a line or two, so they are strictly *more* exposed to the
failure the measurement looks for. Sequencing phase 5 behind phase 3 is what makes that a real
checkpoint rather than a sentence: the measurement lands in phase 3's pull request, and a human
reads it before phase 5's task is released. The alternative - the two running concurrently - would
let phase 5 merge before the number that is meant to validate its premise even exists.

## Cross-phase contracts

- **`src/shared/file-comment-anchor.ts`** (Phase 1): the only definition of an anchor and the only
  re-anchor implementation. Browser-safe, no `node:` imports. Phases 2, 3 and 5 consume it; none
  reimplements it.
- **`file_comment_threads` / `file_comment_messages` / `file_comment_reviews`** (Phase 1): the full
  column shape of all three is declared in phase 1, including the columns phases 3 and 4 will be the
  first to write - `queue_seq`, `delivery_id`, `answered_at`, `addressed_at`, and every column of
  the reviews row - so no later phase needs an `addColumn`.
- **`status` and `outdated` are two dimensions** (Phase 1): `outdated` is a column, not a status
  value, because a thread whose quote stopped resolving keeps its place in the queue and the flag
  clears if the text comes back. `orphaned` is a status, and terminal. No later phase adds a status
  meaning outdated or a flag meaning orphaned.
- **`appendFileCommentMessage`** (Phase 1): the only writer of a `file_comment_messages` row, for
  either author. Phase 2's reply box passes `human`; phase 4's MCP tool passes `agent`.
- **The outstanding-status tuple and its partial unique index** (Phase 1): `sending` and `awaiting`
  both. `unanswered` sits outside it on purpose - decision 3 auto-advances after a grace window,
  so a timed-out thread has to leave the outstanding set or the next delivery collides with it.
  Phase 3 enforces one turn outstanding on top of the index, never instead of it, and never widens
  the tuple to make a transition easier.
- **One route per mutation, declared once** (Phase 1): create, list, delete, reorder, append a
  message, edit an undelivered message, mark read, set status. Phase 2 resolves through the status
  route; phase 3 adds only `start`/`pause`/`resume`.
- **`addressed_at` and `read_at` are written without a status change** (Phase 1):
  `markFileCommentThreadAddressed` and `markFileCommentMessagesRead`. `addressed` is a suggestion
  and `read` is a badge; neither closes a thread, so neither may ride the status route.
- **`queue_seq` is Phase 2's** - a comment joins the review when it is submitted. Phase 3 reorders
  and drains a queue phase 2 fills; it does not fill one.
- **Preview line ranges come from a spec parse, never from matching text** (Phase 5): Markdown from
  `node.position`, HTML from `parse5` with `sourceCodeLocationInfo`, server-side, indexed by the
  bridge's structural path. Text search cannot work (the DOM text of a block with nested markup is
  not a substring of its source) and neither can a tokenizer (the path indexes the browser's tree,
  which has implicit `tbody` and repaired markup in it).
- **A turn carries one message, chosen by `delivered_at`** (Phase 1's column, Phase 3's rule): the
  thread's oldest human message where it is NULL. The thread is the queue position; the message is
  the payload. A requeued thread therefore sends the reply that requeued it, not the comment that
  opened it, and sending stamps the column so nothing goes twice.
- **A message is editable until `delivered_at` is set, and frozen after** (Phase 1). The comment
  body lives in `file_comment_messages`, so phase 2's drafts and phase 3's edit-unsent are the same
  operation; no phase relaxes the refusal or moves the body onto the thread.
- **`file_comment_reviews`** (Phase 1, written only by Phase 3): the review's `idle | running |
  paused` and its pause reason. Run state is not derived from thread statuses - "paused" and
  "never started" are the same rows, and between two comments the outstanding set is briefly empty.
- **Session-scoped lifetime is three mechanisms** (Phase 1): orphan-on-`session_remove`, a
  reconcile arm on `onSessionsObserved`, and a throttled prune of terminal rows. No later phase adds
  a fourth teardown path.
- **`file_comment_thread_upsert` / `file_comment_thread_remove`** (Phase 1): the only wire frames
  for this feature. Phases 3 and 4 emit them; neither adds a variant.
- **Comment eligibility is its own predicate** (Phase 2), never `previewable` (finding 4).
- **One turn outstanding** (Phase 3): the walkthrough submits a single `/inject` human turn and
  never a second until it resolves. Phase 4 changes what *advances* the queue, never how many are
  in flight.
- **`respond_to_file_comments`** (Phase 4): the only agent-facing write. Its name is a string
  literal at the `registerTool` call site (finding 7).

## Final verification strategy

After phase 5, on a single branch: `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build`, `npm run smoke`, and `npm run test:e2e`. The smoke run is not optional here - it is
the only check that proves the built MCP bundle actually publishes the new tool (finding 8).

Then one manual pass a test cannot make: open a real spec in the Files tab, write six comments
across three surfaces, run the walkthrough against a live session, and record how many of the six
reached the head still anchored. That number is the measurement the two 60% assumptions in
`plan.md` need. **Phase 3 is where it is first taken, on editor anchors alone**, and it is recorded
in phase 3's pull request because phase 5's task is gated on a human reading it. This final pass
re-takes it across all three surfaces once they exist.
