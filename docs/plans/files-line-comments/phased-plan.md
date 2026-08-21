# Line comments in the Files workspace - phased implementation

Implementation index for [`plan.md`](./plan.md), approved 2026-08-21 with all five decisions
resolved. Five phases; four merge serially and one runs concurrently.

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

1. **The plan's cleanup design does not match anything in this repository.** It says both tables
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
   `test/db-shell.test.ts:58` (`75`, becomes `77`) and the per-family `<span>N tables</span>` are
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

Estimated **3,000 to 3,900 gross non-test implementation lines**, counting shared contracts,
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
- **2 → 5.** Phase 5 is the only work that touches the shared HTML preview sandbox, a controlled
  security module also used by Scouts. It is worth reviewing on its own, and it does not block
  delivery.

Phase 1 is the largest at roughly 1,100-1,400 lines and is deliberately not split further: cutting
it at the store/route seam would produce two PRs that are each unreviewable without the other.

## Phases

| # | Phase | File | Direct prerequisites |
|---|---|---|---|
| 1 | Anchor, durable model, and wire | [`phase-1-anchor-and-model.md`](./phase-1-anchor-and-model.md) | - |
| 2 | Comment mode in the Editor | [`phase-2-editor-comment-mode.md`](./phase-2-editor-comment-mode.md) | Phase 1 |
| 3 | The walkthrough | [`phase-3-walkthrough.md`](./phase-3-walkthrough.md) | Phase 2 |
| 4 | The agent's reply | [`phase-4-agent-reply.md`](./phase-4-agent-reply.md) | Phase 3 |
| 5 | Preview surfaces | [`phase-5-preview-surfaces.md`](./phase-5-preview-surfaces.md) | Phase 2 |

## Dependency graph and concurrency

```
Phase 1 ──> Phase 2 ──┬──> Phase 3 ──> Phase 4
                      └──> Phase 5
```

**One concurrency group: phases 3 and 5.** Neither consumes a contract the other owns. Phase 3 adds
server-side delivery plus toolbar queue controls; phase 5 adds two renderer integrations. They can
merge in either order.

They do, however, both edit `FileWorkspace.tsx`, so expect a **textual** conflict there even though
there is no contract conflict. Phase 3 edits the toolbar region (`:422-444`); phase 5 edits the
renderer branch (`:446-487`). Whichever merges second rebases; neither changes the other's meaning.

## Cross-phase contracts

- **`src/shared/file-comment-anchor.ts`** (Phase 1): the only definition of an anchor and the only
  re-anchor implementation. Browser-safe, no `node:` imports. Phases 2, 3 and 5 consume it; none
  reimplements it.
- **`file_comment_threads` / `file_comment_messages`** (Phase 1): the full column shape is declared
  in phase 1 including columns phases 3 and 4 will be the first to write, so no later phase needs an
  `addColumn`.
- **`status` and `outdated` are two dimensions** (Phase 1): `outdated` is a column, not a status
  value, because a thread whose quote stopped resolving keeps its place in the queue and the flag
  clears if the text comes back. `orphaned` is a status, and terminal. No later phase adds a status
  meaning outdated or a flag meaning orphaned.
- **`appendFileCommentMessage`** (Phase 1): the only writer of a `file_comment_messages` row, for
  either author. Phase 2's reply box passes `human`; phase 4's MCP tool passes `agent`.
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
`plan.md` need, and phase 3 is where it is taken.
