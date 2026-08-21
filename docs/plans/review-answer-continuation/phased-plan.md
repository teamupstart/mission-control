# Durable review answer continuation: phased implementation plan

## Source of truth

- Approved source plan: `docs/plans/review-answer-continuation/plan.md`
- Recorded solution decision: use durable continuation through the existing pending-turn outbox.
- Recorded follow-up decision: create a phased implementation plan and schedule dependency-linked Mission Control work.

The choices are resolved requirements. This index does not reopen the timeout-only or identical-retry alternatives.

## Repository findings

Mission Control owns review persistence in `src/server/db.ts`, review lifecycle in `src/server/reviews.ts`, review HTTP routes in `src/server/routes.ts`, MCP blocking calls in `src/mcp/server.ts`, and safe later-turn delivery in `src/server/pending-turns.ts`. The daemon long-polls reviews in 30-second slices. That interval is not a 30-minute idle timeout. Once an MCP host cancels the request, however, the original stdio result channel cannot carry a later answer.

The existing pending-turn manager is the correct delivery owner for terminal and SDK sessions. A second terminal-writing path would violate repository ownership. The durable handoff therefore needs to persist review detachment, translate the review result once, and atomically enqueue the continuation through the pending-turn outbox.

The planning checkout already contains a candidate implementation of this design. That is an important discrepancy from a greenfield plan: the phase agent must inspect the default branch it receives, preserve any already-merged conforming work, and change only gaps found against the approved outcome. It must not recreate parallel APIs or migrations merely because the phase document names the intended contracts.

## Sizing and phase-count rationale

The candidate implementation changes about 366 added production lines and 49 removed production lines across shared contracts, SQLite migration and transaction code, MCP transport, review recovery, pending-turn delivery, and daemon wiring. The expected gross implementation range is 350 to 450 non-test lines, assuming the existing review and pending-turn abstractions remain usable.

This is exactly one phase. Although the estimate exceeds 200 lines, the work is one vertical, transaction-sensitive slice. Separating persistence and detach signaling from continuation delivery would merge a durable marker that has no user-visible effect. Separating the outbox consumer first would create a consumer with no trustworthy handoff signal. Keeping migration, session ownership, race handling, recovery, tests, and documentation together makes the merge independently operable and lets one review judge the idempotence contract end to end.

## Phase table

| Phase | Outcome | Direct prerequisites | Repository | Task execution |
| --- | --- | --- | --- | --- |
| 1. Durable detached-review delivery | A human answer reaches the owning session after the MCP wait ends, exactly once and across restart | This planning session and its published artifacts | Mission Control | One-shot, after the planning-session dependency releases |

## Dependency graph and merge order

```mermaid
flowchart LR
  P[Planning artifacts merged] --> F1[Phase 1: durable detached-review delivery]
  F1 --> D[Feature complete]
```

There is one concurrency group containing Phase 1 only. The planning artifact pull request merges first. Its merge publishes every path named by the scheduled task and releases that task. Phase 1 then lands as one reviewable implementation merge. There are no transitive or cross-repository prerequisites.

## Cross-phase contracts

- SQLite remains the durable source of truth for whether an MCP wait detached and whether its continuation was queued.
- The review result formatter is shared by the blocking MCP fast path and the fallback turn so their semantics cannot drift.
- The detach route authenticates with the existing daemon token and binds the caller to the review's owning session.
- Pending-turn persistence and delivery remain owned by the existing pending-turn manager. No direct terminal writer is added.
- Review continuation enqueue is atomic and idempotent across cancellation/answer races and daemon restart.
- Existing blocking review behavior and duplicate-ask handling remain intact.

## Final verification strategy

Phase 1 owns migration compatibility, route authentication, cancellation signaling, result parity, idempotence, restart recovery, session isolation, documentation, and browser-visible delivery. Its focused unit and HTTP tests run with the repository test preload. Typecheck, lint, build, smoke, and the focused Playwright spec close the implementation. A rendered browser assertion proves the late answer appears queued or delivered on the owning session while that session is working.

## Cross-phase audit record

- Source-plan audit: every approved requirement is owned by Phase 1; no alternative solution remains open.
- Ownership audit: the phase uses the existing review manager, SQLite migration path, and pending-turn manager rather than introducing parallel sources of truth.
- Dependency audit: Phase 1 depends directly on this planning session only; there are no hidden later phases required to make its merge operable.
- Existing-work audit: the phase explicitly treats any implementation already merged from this planning checkout as inherited work to verify, not as a reason to duplicate contracts.

## Phase document

- `docs/plans/review-answer-continuation/phase-1-durable-detached-review-delivery.md`
