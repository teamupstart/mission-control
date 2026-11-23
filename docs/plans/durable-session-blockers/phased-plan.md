# Durable session blockers: implementation phases

Source: `docs/plans/durable-session-blockers/plan.md` (managed plan revision 4 and later). Its
Adopted decisions are requirements: placement is a Display setting offering A, C and E with
**In Needs you** (C) as the default; the five blocker fields are Board card items; a flagged
reply is a card pill only.

## Findings that shaped the split

- No session-level blocker exists. `SessionState`, `Tone`, `TASK_STATUSES` and `reportBucket`
  stay unchanged; the hold is a new predicate applied at each gate the plan lists. Every gate
  named in the plan exists today (`decidePromptedWrapup`, `consumePromptedGeneration`,
  `decideQueueTick`, `decideShipRecovery`, `followupOwnershipBlocker`, `agentIsFree`,
  `StackReadiness.finishedEpisode`, `resumableRun`, `workOutstanding` in `src/shared/stall.ts`).
- Note-keyed state is pruned by liveness and age (`Registry.pruneGoals`, gated on the first
  sweep), not on `session_remove`, because a resumed conversation keeps its key. The source plan
  now says the same.
- `CURRENT_DATABASE_SCHEMA_VERSION` is 22; this work takes 23.
- E2E specs reach MCP routes with `POST /mcp/...` and the daemon's token file
  (`e2e/specs/review-draft-retained.spec.ts`), so a spec can set a blocker without a model.
- Placement precedent: `ResidentPlacementPanel` and `RESIDENT_PLACEMENTS`. Card item precedent:
  `DISPLAY_ITEMS` in `src/web/lib/board-card.ts`, guarded by `test/board-card-items.test.ts`.
- Each Board column has exactly one scrollport (`.board-col-body`); the stacked-lane placement
  is the largest layout change in the plan.

## Sizing

Estimated 1,600 to 2,200 non-test lines. Phase 1 (record, tools, gates, resident reads, card and
detail band) about 1,000 to 1,300; Phase 2 (setting and three placements) about 600 to 900.
Assumes the existing registry, settings and column machinery are reused as the plan describes.

Two phases, not one: the combined change touches persistence, Foreman, workflows, MCP and a
column layout rewrite, too much for one reviewable pull request. Not three: shipping the record
without the card and the detail band would hold sessions where nobody can see or clear the
hold, so the server work and its minimal UI stay together in Phase 1.

## Phases

| Phase | File | Depends on | Delivers |
|---|---|---|---|
| 1 | `phase-1-durable-blocker.md` | planning merge | The blocker record, tools, automation hold, resident reads, blocked card with its card items, and the session-detail band. Blocked idle sessions stay in Idle. |
| 2 | `phase-2-blocked-placement.md` | Phase 1 | Settings → Display → Blocked sessions with In Needs you (default), At the top of Idle, and Own column, plus the Console rail group and keyboard order. |

Graph: planning session, then Phase 1, then Phase 2. No phases run concurrently. Merge order
1 then 2.

## Cross-phase contracts

- `Session.blocker: SessionBlocker | null` and `SESSION_BLOCKER_KINDS` in `src/shared/types.ts`
  (Phase 1 owns; Phase 2 reads only).
- `hasBlocker(s)` in `src/shared/session.ts` is the one predicate (Phase 1). Phase 2 places by
  it and adds no second test.
- The blocked tile carries class `is-blocked` and the always-on `Blocked · age` flag (Phase 1).
  Phase 2 moves tiles, it does not restyle them.
- The five card item ids `blockerKind`, `blockerReason`, `blockerWaitingOn`, `blockerLink`,
  `blockerReply` (Phase 1).

## Final verification

After Phase 2: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run smoke`, `npm run test:e2e` with both phases' specs passing, and the source plan's
Verification list satisfied.
