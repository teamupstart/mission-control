# Phase 1: Contracts and handoff API

Plan: `docs/plans/headless-mode/plan.md`. Spec sections 2, 3.1 to 3.4, 4. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

The daemon can register home sessions, record task origin, report an inbox, relay answers and plan approvals with receipts, keep the turn log, and decide once per new session whether the launcher question should be asked. Every later phase builds on these contracts.

## 2. Entry criteria and dependencies

None. This phase is first.

## 3. Scope and non-goals

In scope: land Phase 0, the contracts delta (spec 2.4), switches (2.5), routes in spec 3.1 to 3.4 and section 4 (including the launcher offer in `turns/open`), the `launcher.banner` field of the sessions response, worker-refusal rules. Not in scope: the dispatch-options route (phase 2), hooks, MCP tools, CLI, setup, any `src/web/` change.

## 4. Repository findings and inherited contracts

- Phase 0 lives only on local branch `feat/headless` (commits `ae01b4e3c`, `457b2335f`, `5e627037c`; the docs commits on that branch are not wanted, this plan owns the docs). It adds `src/shared/handoff.ts`, schema 35 in `src/server/db.ts`, `src/server/handoff/routes.ts` stubs, `src/mcp/handoff-tools.ts`, `src/cli/*` stubs, `hooks/handoff-hook.mjs`, build scripts and `todo` tests. Cherry-pick those three commits; if the ref is unavailable rebuild from spec section 2.
- Actors and approvals: `loadHumanResolvedReviews` in `src/server/db.ts` and `approval()` in `src/server/plans/publication.ts` must treat `home-approval:` as human and `home:` and `session:` as not human.
- In-process resolve pattern: `src/server/session-control.ts` builds a request to the review resolve route.
- Worker identity: Mission-managed session ids are known to the registry.
- Settings registry: `src/shared/app-config-entries.ts` classifies each key (`setting`); `ui.guidedDispatch` is an existing example.

## 5. Implementation steps

1. Land Phase 0 (cherry-pick), run its tests, confirm green on `main`.
2. Contracts delta (spec 2.4): add `shelved` to `INBOX_STATES` and `InboxItemSchema`; add `HANDOFF_KIND_ORDER`, `recommendKind`, `pageOptions`, `LAUNCHER_CHOICES`, the guided and launcher schemas, `TurnOpenResponseSchema`, and the registration fields `source` and `entrypoint`; add `start_source`, `entrypoint`, `launcher_offered_at` to `handoff_sessions`; add `read_dispatch_options` to `MISSION_MCP_TOOLS` and the pinned inventories. Replace the matching `todo` tests (AC-C-*, helper parts of AC-GUIDE-02 and 03) with real ones.
3. Sessions route (3.1): upsert with source and entrypoint, repo resolution, `launcher.banner` built from `HANDOFF_KINDS` (the text changes with the launcher setting), 403 for Mission-managed ids (AC-API-18), stale id mapping by `claude_pid` (AC-API-19).
4. Task origin (3.2): set origin on tasks created through the MCP create route by a registered session, and by surface `cli`.
5. Inbox (3.3) with the six states and ordering.
6. Answers (3.4) with receipts, actor set server side, 403, 409, 400 rules.
7. Turn log and plan approval (4.1 to 4.3), including the daily cleanup, `TurnOpenResponse`, and the launcher offer rule (first real turn, `startup`, interactive entrypoint, not a slash command, setting on, registered, once).
8. Register `handoff.launcher.prompt` (default true) as a `setting`; include it in the data `mctl config view` will print (phase 5 prints it).
9. Wire each handler through `registerHandoffRoutes`; validate bodies with `parseBody`.

## 6. Data, API and compatibility

Schema 35 only (not yet released, so add the columns to the same `CREATE TABLE`; use `addColumn` too for any database that already ran the earlier 35). Dashboard routes must behave exactly as before (AC-API-16). No new persisted spellings beyond `home:`, `home-approval:` and `mctl`.

## 7. Tests and verification

Owns AC-C-01 to AC-C-08, AC-API-01 to AC-API-21, AC-TURN-01 to 05, AC-PLAN-01 to 07, AC-LAUNCH-05, 06, 07, 11 (daemon side). Run each file with `node --test --import ./test/setup-state.mjs --import tsx test/{file}.test.ts`, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## 8. Merge and exit criteria

All owned rows pass with no `todo`; schema 35 migrates and reopens idempotently; typecheck, lint, tests, build and smoke are green.

## 9. Downstream handoff

Later phases rely on the route paths, schemas, `launcher.banner`, `launcher.offer`, `recommendKind`, `pageOptions`, inbox states and the actor values. They must not rename any of them. Spike S-06 (interactive entrypoint value) is recorded here when answered; until then only `cli` is accepted.

## 10. Cross-phase audit

Phase 2 consumes the guided schemas added here; phase 3 consumes the sessions and turns routes and the `launcher.offer` flag; phase 5 consumes inbox and answers routes and prints the launcher setting. No later phase edits `db.ts`.
