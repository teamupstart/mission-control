# Phase 1: Durable blocker, end to end

## Outcome

A session can record and clear a blocker; it survives turns and restarts; every idle-triggered
automation holds while it stands; residents can list, flag and clear blockers; and you see a red
blocked card with its fields and a detail band with **Flag reply** and **Clear blocker**.
Blocked idle sessions stay in the Idle column until Phase 2 adds placement.

## Entry criteria

The planning pull request has merged, so `plan.md`, `phased-plan.md` and this file are on the
default branch. No phase dependency.

## Scope

Everything in the source plan except Settings → Display → Blocked sessions, the three
placements, the Console rail Blocked group, and the blocked-first ordering (Phase 2).
Non-goals: Commonroom integration, reply detection, a task status, `list_tasks` fields.

## Findings and inherited contracts

Gates, pruning precedent, schema version and the e2e MCP precedent are listed in
`phased-plan.md`. The session-control read projection is a hand-written field pick in
`src/server/session-control.ts`; the single-session read returns the whole `Session`.

## Steps

1. **Shared.** `SESSION_BLOCKER_KINDS`, `SessionBlocker`, `Session.blocker` in
   `src/shared/types.ts`; Zod schemas for the MCP body, clear, reply, the read filter and two
   `SessionControlActionSchema` actions in `src/shared/protocol.ts`; `hasBlocker(s)` in
   `src/shared/session.ts`.
2. **Database.** `session_blockers` keyed by `note_key` with `task_id`, created in `migrate()`;
   schema 23 with a changelog line; load, upsert, delete, move-key and prune functions.
3. **Registry.** Load at construction; project in `mergeDiscovered`, `registerSdkSession`,
   `applyHook`, `applyDriverBinding`; `SESSION_FIELD_COMPARATORS` entry; move on key rotation
   beside `moveStandingInstructionsKey`; a `pruneGoals` twin; `session_events` rows for set,
   update, reply flag and clear.
4. **Task end.** Clear the blocker when the bound task reaches a terminal status
   (`finishCompletion`, cancel, fail, merge settlement).
5. **Routes.** `/mcp/blocker` and `/mcp/blocker/clear` bound like `/mcp/status`, refusing set
   while the session has a pending `request_input` review; `/api/sessions/:id/blocker/reply`
   and `/clear`; session-control read summary and `blocked` filter; two `controlRequest`
   mappings.
6. **MCP.** `report_blocker` and `clear_blocker` in `src/mcp/server.ts` with the plan's
   description and result text; add both to `MISSION_MCP_TOOLS`.
7. **Hold.** Apply `hasBlocker` at every gate in the plan's table. Prompted completion must skip
   without consuming the generation. Stall rules skip blocked sessions.
8. **Guidance.** The two sentences in `REDIRECT_PROMPT` and
   `MISSION_CONTROL_REVIEW_INSTRUCTION`; the Agent Shepherd section in
   `residents/agent-shepherd.md`, then regenerate its generated file.
9. **Card.** `is-blocked` tile with danger spine and border (launch-failure precedent, tokens
   only); always-on `Blocked · age` flag; five `DISPLAY_ITEMS` card entries rendered on the tile.
10. **Detail band.** Red band at the top of the Conversation tab with every field, collapsible
    details, reply flag, and the two buttons calling the dashboard routes.
11. **Docs.** `docs/sessions.md`, `docs/residents.md`, `docs/attention-and-alerts.md`,
    `docs/ui.md` (card and band), `docs/observability-action-manifest.md`,
    `docs/database-and-migrations.md`.

## Compatibility

Additive table and nullable wire field; an upgraded database gains an empty table. Older clients
ignore `blocker`. No persisted IDs are renamed.

## Tests

Unit tests for every item in the plan's `test/` list except placement ordering, plus
`test/board-card-items.test.ts` for the five ids. E2E `e2e/specs/session-blocker.spec.ts`: set a
blocker through `/mcp/blocker`, see the red card in Idle with its fields, hide one card item,
open the band, flag a reply (pill, no alert), restart the daemon and see it again, clear it.
Then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
`npm run test:e2e`.

## Exit criteria

All of the above pass; a blocked idle session is visible, held, readable by a controller and
clearable from the dashboard.

## Handoff to Phase 2

Phase 2 may rely on `Session.blocker`, `hasBlocker`, the `is-blocked` tile and the card items,
and must not change the record, the tools or the gates.

## Cross-phase audit

Checked against Phase 2: Phase 2 owns no shared type, route or gate; it only adds a UI setting
and moves tiles. No conflicts.
