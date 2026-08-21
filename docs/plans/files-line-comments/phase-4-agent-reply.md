# Phase 4: The agent's reply

## Outcome

The agent answers a comment with a tool call, and the answer appears in that thread, on that line,
live, without a refresh - and it is what releases the next comment. The Files tab raises an
attention pip when a reply lands. A session with no such tool still works, through the bracketed id
in the payload.

The queue stops advancing on an inference about idleness and starts advancing on a real completion.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 3**, merged. This phase needs the outstanding-thread concept and the
  walkthrough's release point to hook into.

## Scope

1. **`respond_to_file_comments({ commentId, body, addressed? })`** in `src/mcp/server.ts`,
   registered in the non-blocking `share_plan` shape (`src/mcp/server.ts:162-181`): an
   `inputSchema` that is a **bare object of zod fields** with `.describe()` on each, a handler
   taking only the destructured args and **no `extra`** (the visible marker of non-blocking), and a
   `textResult(...)` return. It posts and carries on; it does not long-poll.
   - **`commentId` is the payload's `MC-xxxx` handle - the thread's `short_id` - and not the row's
     UUID.** This is the whole point of minting a short id in phase 1: it is the only comment
     identifier the agent is ever shown, because the payload cites it and nothing hands the agent a
     UUID. An implementation that reads `commentId` as `file_comment_threads.id` produces a tool no
     agent can call, which is the failure mode this bullet exists to prevent. Say so in the field's
     `.describe()` too, since that string is what the agent actually reads.
   - **The tool name must be a bare string literal at the `registerTool(` call site.**
     `test/mission-mcp.test.ts:125-133` scrapes `/registerTool\(\s*"([a-z_]+)"/g` and asserts sorted
     set equality against `MISSION_MCP_TOOLS`. A named constant there breaks the scrape - which is
     why every existing tool is a literal in `server.ts` even when `mission-mcp.ts` names it via a
     symbol.
2. **The mirrored Zod schema.** MCP arguments are validated twice on purpose - once in
   `src/shared/protocol.ts` and once as a hand-written mirror in `src/mcp/server.ts`
   (`change-contracts.md:44`). Change both; `test/mission-mcp.test.ts` catches a rename.
3. **`MISSION_MCP_TOOLS`** in `src/server/mission-mcp.ts:55`. Without the entry, no launch can
   pre-approve the tool and calling it stops the agent on a permission prompt. Keep the array in its
   exact syntactic form - `test/mission-mcp.test.ts:169-192` re-scrapes it with a regex and requires
   `scripts/smoke-bundles.mjs` to resolve every name.
   - Consider whether `KIND_MISSION_MCP_TOOLS` (`:106`) should require it for any task kind. The
     recommendation is **no**: this tool is reachable when a human is reviewing a file, which is not
     a property of the task's kind.
4. **`POST /mcp/file-comments/replies`** in `src/server/routes.ts`, in the `/mcp/reviews` shape
   (`routes.ts:2799-2809`): `authed(c)` → `parseBody` → destructure `{ env, sessionId, cwd, ... }` →
   `registry.findSessionByEnv(env, sessionId, cwd)` → 404 `"no matching session"`. Note `/mcp/*` is
   deliberately **not** behind `requireLoopback`; the token is the gate.
   - **Resolve `commentId` to a thread scoped to that session, never globally.** `short_id` is
     unique *per session* (phase 1), so two sessions can each hold an `MC-a41f` and a global lookup
     would file a reply onto another session's thread - a silent cross-session write, not a 404.
     Look the short id up within the session `findSessionByEnv` just returned, and refuse with a
     clear error when it does not resolve there. **Never fall back to a global lookup** on a miss:
     the fallback is what turns an honest refusal into the wrong thread.
5. **Persist, emit, advance.** The reply is stored through phase 1's `appendFileCommentMessage`
   with author `agent` - the same function phase 2's reply box uses. `addressed?` calls phase 1's
   `markFileCommentThreadAddressed`, **not the status route**: `addressed` is a suggestion and
   never a closure, so it must be writable without moving the thread anywhere. Both writes happen
   in one transaction with the insert, so a thread is never seen as addressed by a reply that did
   not persist. One `file_comment_thread_upsert` carries the result to every dashboard.
   - **The insert is unconditional; the status change is not.** A reply is real content and is
     always persisted - dropping one because it arrived late would lose the agent's work. What is
     conditional is everything else:
     - **Move the thread to `answered` only when it is in `awaiting` or `unanswered` and carries no
       undelivered human message.** That second test is not a new invariant: it is the same
       `delivered_at IS NULL` predicate the payload selection rule already uses, and an undelivered
       human message *is* queued work.
     - **Otherwise leave the status exactly as it is.** This is the case that matters. Decision 3
       auto-advances, so a thread can time out to `unanswered`, the human can write a follow-up
       that puts it back to `queued` with a fresh `queue_seq`, and only then can the agent's slow
       reply land. Moving that thread to `answered` would take it out of the queue and the
       follow-up would never be delivered - human work lost silently, with the reply that caused it
       looking like a success. A `resolved` thread is left alone by the same rule: only a person
       closes a thread, and a late reply does not reopen one.
     - **Release the next comment only when the reply answers the outstanding delivery** - the
       thread whose `delivery_id` is the turn actually in flight. A late reply persists, notifies,
       and advances nothing.
   - `commentId` stays **required** even though only one comment is outstanding. It costs one field
     and it is what stops a late reply - the agent answering comment 3 after the walkthrough moved to
     comment 5 - from being misfiled onto the wrong thread. Required and session-scoped are doing
     two different jobs here: required stops a *late* reply landing on the wrong thread in the same
     session, session-scoped stops it landing on another session's thread entirely.
6. **Name the tool in the payload.** Phase 3 shipped the closing instruction asking for an answer
   in the next turn with no tool named, because this tool did not exist. Substitute
   `respond_to_file_comments` and the thread's `short_id` into that one line and change nothing
   else about the renderer. Without this the delivered payload never tells an agent how to reply,
   which is the whole point of this phase.
7. **The Files tab pip**, counting agent replies whose `read_at` is NULL - not queue depth, which is
   the human's own work. Expanding a thread calls phase 1's `markFileCommentMessagesRead`, which is
   what clears it. The count is durable rather than browser state because the integrated tab and
   the extracted Files window are two instances that converge only through the daemon, so a badge
   kept in one would be wrong in the other.
   - `detailTabs()` (`src/web/lib/detailTabs.ts:43-51`) hard-codes `pip: 0` for Files, but so do
     three of the other four tabs; only `queue` takes a count. Add a second field to
     `DetailTabInputs` and supply it from `ConsoleDetail.tsx:378`.
8. **The transcript fallback.** A session an operator started without the Claude integration has no
   such tool. An assistant turn opening with the thread's `short_id` is filed into that thread by
   the transcript reader. Less precise, and the only thing that works everywhere.
9. **`docs/sessions.md`**: what a comment looks like as a turn, and where it queues.

## Non-goals

- No `list_file_comments` read tool. The delivered payload is the read path.
- No blocking variant. The agent must not wait on a human here.
- No change to how many turns are outstanding. Phase 3 owns that and it stays at one.
- No preview-surface work. Phase 5.

## Repository findings this phase rests on

- **A tool result cannot draw itself in the conversation.** Every harness parser drops a user turn
  that is purely a tool result as machine noise - the reason `ReviewAnswerCard` exists
  (`src/web/components/ReviewAnswer.tsx:8-13`). The thread must render from durable state.
- **`findSessionByEnv`** (`registry.ts:2878`) resolves in three steps: pane token from `env`, then
  `agentSessionId`, then a **unique** `cwd` match. The cwd branch deliberately does not filter by
  agent, because uniqueness is the tie-break that matters.
- **The build obligation is silent.** A dispatched agent runs the gitignored `dist/mcp/server.mjs`,
  which only `npm run build` refreshes (`change-contracts.md:46`). Source alone never reaches a
  session. `npm run smoke` performs a real `initialize` + `tools/list` handshake against the built
  bundle and is what catches it; the daemon also warns at boot via `reportMissionMcpDrift`
  (`mission-mcp.ts:754`).

## Verification

- Extend `test/mission-mcp.test.ts` expectations for the new tool - or rather, confirm the existing
  drift tests now pass with it, since they are generic over the list.
- Extend `test/file-comments-http.test.ts` for the `/mcp` route, including the env join. Post with
  `x-harness-token` from `ensureToken()`; no `host` header is needed for `/mcp/*`. Cover the
  identifier directly: a reply naming the payload's `MC-xxxx` resolves and persists, and **two
  sessions each holding the same `short_id` file onto their own threads** - with the miss refused
  rather than resolved globally. That last case is the one a global lookup passes silently.
- Extend `test/file-comment-walkthrough.test.ts`: a reply advances immediately, and a reply naming a
  thread that is no longer outstanding lands on that thread without advancing anything. Add the
  round-14 case explicitly, because it is the one that loses data rather than merely misreporting:
  time a thread out to `unanswered`, add a human follow-up so it returns to `queued` with a
  `queue_seq`, then deliver the late agent reply - the message must persist while the thread stays
  `queued`, keeps its place, and still delivers the follow-up. Cover `resolved` the same way.
- `e2e/specs/file-comment-walkthrough.spec.ts` gains a faked reply: read the token from
  `join(daemon.home, "token")`, `POST /mcp/file-comments/replies` with `x-harness-token`, `env: {}`
  and the session's `cwd`, exactly as `e2e/specs/review-answers-in-conversation.spec.ts:58-101`
  does. Assert the reply appears in the thread and that the next comment goes.
- **`npm run smoke` is not optional in this phase.** It is the only check that proves the built
  bundle publishes the tool.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## Merge and exit criteria

- The tool appears in a real `tools/list` handshake against `dist/mcp/server.mjs`.
- A reply persists, reaches every dashboard live, and releases the next comment.
- A late reply lands on its own thread and advances nothing, and **does not move a thread the human
  has already requeued** - the follow-up is still delivered afterwards.
- A reply quoting the `MC-xxxx` the payload printed resolves to that thread, and the same handle in
  another session resolves to that session's thread and not this one.
- The Files tab raises a pip when a reply arrives.
- `npm run smoke` passes.

## Downstream handoff

Phase 5 is this phase's **concurrent sibling**, not its dependent - both depend on phase 3, and
either may merge first - so phase 5 must build on none of this. Should it merge second, it may rely
on, and must not change: the reply route and tool, the pip, and the fact that a
thread renders from durable state rather than from the transcript.

## Cross-phase audit record

- Initial authoring, after Phase 3.
- Confirmed the `answered_at` column exists from Phase 1, so no `addColumn`.
- Confirmed against Phase 3 that adding the reply signal is additive: the idle fallback stays as the
  floor, so no edit to Phase 3's state machine contract is required.
- Recorded that `commentId` stays required, against the source plan's note that one-at-a-time makes
  the ids unnecessary. It is a safety net for the late-reply case, not the primary mechanism.
- Review pass (round 13): **the tool took an identifier the agent is never given.** The payload
  prints the thread's `MC-xxxx`, the tool declared `commentId`, and this phase never said they were
  the same value - so an implementer reading only this file would reasonably bind `commentId` to
  `file_comment_threads.id`, producing a tool no agent can call and a phase whose entire outcome
  fails silently. `plan.md` had said "the reply tool takes it", but a phase file has to stand on its
  own for an agent that arrives with nothing but its path. Now stated in the scope, in the field's
  `.describe()`, and in the exit criteria. The same pass added the half that was missing everywhere:
  `short_id` is unique *per session*, so resolution must be session-scoped or a reply can be filed
  onto another session's identically-named thread - a silent cross-session write rather than a 404.
- Review pass (round 14): **an unconditional `answered` transition could delete queued human work.**
  Decision 3 auto-advances, and `unanswered ──human replies──▶ queued` is an approved transition, so
  a thread can time out, be requeued by a follow-up, and only then receive the agent's slow reply.
  Moving it to `answered` at that point takes it out of the queue and the follow-up is never
  delivered - silently, with the reply that caused it reported as a success. The insert stays
  unconditional (a reply is real content); the status change and the queue advance are now both
  conditional on the thread still being the one that reply answers. The gating predicate reuses the
  payload selection rule's `delivered_at IS NULL` rather than inventing a second notion of
  "pending", and the same rule leaves a `resolved` thread closed.
