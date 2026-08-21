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
   (`routes.ts:2743-2753`): `authed(c)` → `parseBody` → destructure `{ env, sessionId, cwd, ... }` →
   `registry.findSessionByEnv(env, sessionId, cwd)` → 404 `"no matching session"`. Note `/mcp/*` is
   deliberately **not** behind `requireLoopback`; the token is the gate.
5. **Persist, emit, advance.** The reply is stored in `file_comment_messages`, the thread moves to
   `answered`, one `file_comment_thread_upsert` carries it to every dashboard, and the walkthrough
   releases the next comment.
   - `commentId` stays **required** even though only one comment is outstanding. It costs one field
     and it is what stops a late reply - the agent answering comment 3 after the walkthrough moved to
     comment 5 - from being misfiled onto the wrong thread.
6. **The Files tab pip.** `detailTabs()` (`src/web/lib/detailTabs.ts:43-51`) hard-codes `pip: 0` for
   Files, but so do three of the other four tabs; only `queue` takes a count. Add a second field to
   `DetailTabInputs` and supply it from `ConsoleDetail.tsx:378`.
7. **The transcript fallback.** A session an operator started without the Claude integration has no
   such tool. An assistant turn opening with the bracketed id is filed into that thread by the
   transcript reader. Less precise, and the only thing that works everywhere.
8. **`docs/sessions.md`**: what a comment looks like as a turn, and where it queues.

## Non-goals

- No `list_file_comments` read tool. The delivered payload is the read path.
- No blocking variant. The agent must not wait on a human here.
- No change to how many turns are outstanding. Phase 3 owns that and it stays at one.
- No preview-surface work. Phase 5.

## Repository findings this phase rests on

- **A tool result cannot draw itself in the conversation.** Every harness parser drops a user turn
  that is purely a tool result as machine noise - the reason `ReviewAnswerCard` exists
  (`src/web/components/ReviewAnswer.tsx:8-13`). The thread must render from durable state.
- **`findSessionByEnv`** (`registry.ts:2833`) resolves in three steps: pane token from `env`, then
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
  `x-harness-token` from `ensureToken()`; no `host` header is needed for `/mcp/*`.
- Extend `test/file-comment-walkthrough.test.ts`: a reply advances immediately, and a reply naming a
  thread that is no longer outstanding lands on that thread without advancing anything.
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
- A late reply lands on its own thread and advances nothing.
- The Files tab raises a pip when a reply arrives.
- `npm run smoke` passes.

## Downstream handoff

Phase 5 may rely on, and must not change: the reply route and tool, the pip, and the fact that a
thread renders from durable state rather than from the transcript.

## Cross-phase audit record

- Initial authoring, after Phase 3.
- Confirmed the `answered_at` column exists from Phase 1, so no `addColumn`.
- Confirmed against Phase 3 that adding the reply signal is additive: the idle fallback stays as the
  floor, so no edit to Phase 3's state machine contract is required.
- Recorded that `commentId` stays required, against the source plan's note that one-at-a-time makes
  the ids unnecessary. It is a safety net for the late-reply case, not the primary mechanism.
