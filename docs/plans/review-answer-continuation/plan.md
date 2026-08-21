# Durable review answer continuation

## Goal

Make a human review answer reach its session even when the original blocking MCP tool call has already been canceled by the host.

## Approved decisions

- Use durable review-answer continuation through the existing pending-turn outbox. Raising the MCP timeout and replaying an identical ask remain defense-in-depth ideas, not the primary solution.
- After finalizing this source plan, create a phased implementation plan and schedule its dependency-linked Mission Control task.

## Current behavior

Mission Control waits in 30-second daemon long-poll slices and emits MCP progress notifications when the client provides a progress token. Progress is not an unlimited lease: the MCP contract permits timeout resets but recommends a maximum timeout. Once the host cancels the tool call, a later answer is persisted and shown in the conversation, but no live result channel remains to resume the agent.

Current flow:

```text
agent -> MCP child -> daemon review waiter
human -> daemon review resolution -> canceled MCP result channel (answer stops)
```

## Recommended design

Keep the blocking MCP result as the fast path. Add a durable continuation path only after the host cancels it:

```text
agent -> MCP child -> daemon review waiter
host cancellation -> MCP child -> mark review wait detached in SQLite
human -> daemon review resolution -> pending-turn outbox -> same agent session
```

The answer delivered as a later turn will identify the original review and carry the same semantic result the MCP tool would have returned: input text or dismissal, plan selections or dismissal, and diff approval or requested changes plus the review note.

## Implementation

1. Add nullable review delivery timestamps beside the existing review migration path: when the MCP wait detached and when its continuation was queued.
2. Add a token-guarded MCP route that marks a review wait detached only when the caller resolves to the review's owning session.
3. On MCP cancellation, notify that route without reusing the canceled fetch signal. Also treat pending reviews restored after a daemon restart as detached because their former stdio request cannot survive that process boundary.
4. Add one shared review-result formatter so the blocking MCP return and fallback turn cannot disagree.
5. Extend the durable pending-turn outbox with an idempotent review-continuation enqueue. Create the pending turn and stamp the review in one SQLite transaction.
6. When a detached human-authored review resolves, enqueue its formatted result. Reconcile any resolved but not yet queued continuation on startup.
7. Correct the documentation and source comments that currently describe progress as an unlimited wait.

## Verification

- Unit test cancellation before the answer, cancellation after resolution, restart recovery, session ownership, and idempotent enqueue.
- HTTP integration test the MCP detach route and answer-to-outbox transition.
- MCP bundle test that cancellation triggers the detach request.
- Playwright test that an answered detached review clears the review card and leaves a queued or delivered continuation on the owning session, never another session.
- Run focused tests, typecheck, lint, build, smoke, and the focused Playwright spec.

## Alternatives

### Raise the MCP timeout

Set a much larger per-tool timeout on launches. This is useful defense in depth but still has a deadline, depends on host-specific configuration, and does not recover an answer after cancellation.

### Replay a recently answered identical ask

Return the prior answer when a model retries the same question. This helps only after a retry and cannot reliably distinguish a retry from a legitimate repeated question without a stable request key.

## Scope boundary

This change does not remove blocking reviews, change review UI controls, or invent another direct terminal writer. Fallback answers enter through the existing pending-turn manager, which already owns safe delivery to terminal and SDK sessions.
