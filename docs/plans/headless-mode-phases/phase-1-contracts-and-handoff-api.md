# Phase 1: Contracts and handoff API

Plan: `docs/plans/headless-mode/plan.md`. Spec sections 2, 3.1 to 3.4, 4. Index: `docs/plans/headless-mode-phases/phased-plan.md`.

## 1. Outcome

The single spike branch `feat/headless-mode-spike` exists on origin, and the daemon on it can register home sessions, record task origin, report an inbox, relay answers and plan approvals with receipts, keep the turn log, and decide once per new session whether the launcher question should be asked. Every later phase builds on these contracts.

## 2. Entry criteria and dependencies

None. This phase is first.

## 3. Scope and non-goals

In scope: create and push the spike branch, the contracts delta (spec 2.4), switches (2.5), routes in spec 3.1 to 3.4 and section 4 (including the launcher offer in `turns/open`), the `launcher.banner` field of the sessions response, worker-refusal rules. Not in scope: the dispatch-options route (phase 2), hooks, MCP tools, CLI, setup, any `src/web/` change, any pull request or second upstream branch.

## 4. Repository findings and inherited contracts

- Phase 0 lives only on the local branch `feat/headless` (commits `ae01b4e3c`, `457b2335f`, `5e627037c`, plus earlier docs commits that this plan supersedes). It adds `src/shared/handoff.ts`, schema 35 in `src/server/db.ts`, `src/server/handoff/routes.ts` stubs, `src/mcp/handoff-tools.ts`, `src/cli/*` stubs, `hooks/handoff-hook.mjs`, build scripts and `todo` tests. It is not on `origin`.
- Actors and approvals: `loadHumanResolvedReviews` in `src/server/db.ts` and `approval()` in `src/server/plans/publication.ts` must treat `home-approval:` as human and `home:` and `session:` as not human.
- In-process resolve pattern: `src/server/session-control.ts` builds a request to the review resolve route.
- Worker identity: Mission-managed session ids are known to the registry.
- Settings registry: `src/shared/app-config-entries.ts` classifies each key (`setting`); `ui.guidedDispatch` is an existing example.

## 5. Implementation steps

1. Create the branch: from the checkout that has local `feat/headless`, run `git push origin feat/headless:feat/headless-mode-spike`, then work on top of `origin/feat/headless-mode-spike`. If the local ref is unavailable rebuild Phase 0 from spec section 2 and push it as that branch. Run the Phase 0 tests and confirm they are green. Do not open a pull request.
2. Contracts delta (spec 2.4): add `shelved` to `INBOX_STATES` and `InboxItemSchema`; add `HANDOFF_KIND_ORDER`, `recommendKind`, `pageOptions`, `LAUNCHER_CHOICES`, the guided and launcher schemas, `TurnOpenResponseSchema`, and the registration fields `source` and `entrypoint`; add `start_source`, `entrypoint`, `launcher_offered_at` to `handoff_sessions`; add `read_dispatch_options` to `MISSION_MCP_TOOLS` and the pinned inventories. Replace the matching `todo` tests (AC-C-*, helper parts of AC-GUIDE-02 and 03) with real ones.
3. Sessions route (3.1): upsert with source and entrypoint, repo resolution, `launcher.banner` built from `HANDOFF_KINDS` (the text changes with the launcher setting), 403 for Mission-managed ids (AC-API-18), stale id mapping by `claude_pid` (AC-API-19).
4. Task origin (3.2): set origin on tasks created through the MCP create route by a registered session, and by surface `cli`.
5. Inbox (3.3) with the six states and ordering.
6. Answers (3.4) with receipts, actor set server side, 403, 409, 400 rules.
7. Turn log and plan approval (4.1 to 4.3), including the daily cleanup, `TurnOpenResponse`, and the launcher offer rule (first real turn, `startup`, interactive entrypoint, not a slash command, setting on, registered, once).
8. Register `handoff.launcher.prompt` (default true) as a `setting`.
9. Wire each handler through `registerHandoffRoutes`; validate bodies with `parseBody`.
10. Commit in small steps and push to `feat/headless-mode-spike` (fetch, rebase, fast-forward only).

## 6. Data, API and compatibility

Schema 35 only (not yet released, so add the columns to the same `CREATE TABLE`; use `addColumn` too for any database that already ran the earlier 35). Dashboard routes must behave exactly as before (AC-API-16). No new persisted spellings beyond `home:`, `home-approval:` and `mctl`. Alpha: contracts may still change; record changes in the report.

## 7. Tests and verification

Owns AC-C-01 to AC-C-08, AC-API-01 to AC-API-21, AC-TURN-01 to 05, AC-PLAN-01 to 07, AC-LAUNCH-05, 06, 07, 11 (daemon side), and AC-DEL-05 for its own pushes. Run each file with `node --test --import ./test/setup-state.mjs --import tsx test/{file}.test.ts`, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## 8. Exit criteria

All owned rows pass with no `todo`; schema 35 migrates and reopens idempotently; typecheck, lint, tests, build and smoke are green; `origin/feat/headless-mode-spike` holds Phase 0 plus this phase's commits and no other upstream branch does. The operator then releases dependents (Unblock dependents on this task).

## 9. Downstream handoff

Later phases rely on the branch, route paths, schemas, `launcher.banner`, `launcher.offer`, `recommendKind`, `pageOptions`, inbox states and the actor values. They must not rename any of them. Spike S-06 (interactive entrypoint value) is recorded here when answered; until then only `cli` is accepted.

## 10. Cross-phase audit

Phase 2 consumes the guided schemas added here; phase 3 consumes the sessions and turns routes and the `launcher.offer` flag; phase 5 consumes inbox and answers routes and prints the launcher setting. No later phase edits `db.ts`. Only this phase creates the branch.
