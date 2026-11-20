# Phase 1: Contracts, flag and server seams (WP1a)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18, sha256 prefix `feece382`.

**1. Outcome.** The `headless-mode` preview flag exists, every shared contract, schema 36 and every route seam is on `main` as a stub, and the existing Focus feature is guarded. Nothing visible happens with the flag off.

**2. Entry and dependencies.** None. No prerequisite phases.

**3. Scope.** One registry entry in `src/shared/feature-flag-registry.ts`. All shared schemas in `src/shared/home-dispatch*.ts`: registration answer, inbox item, resident, transcript, `CodexReadiness`. Schema 36 in `src/server/db.ts`. `src/server/home-dispatch/routes.ts` plus stub modules for every `/dispatch/*` route (including residents, transcript and its stream, send, readiness), 501 while the flag is on, absent while off. One `registerHomeDispatchRoutes` call in `src/server/routes.ts` and the `home-dispatch-v1` health capability. Regenerated route oracle, flag-off tests, the Settings-row Playwright spec, and the three Focus guards of plan 4.2. Non-goals: CLI, mod, pane, any real behavior.

**4. Findings.** `main` is at schema 35 and has no preview flag, so this is the first real flag and owes a browser assertion that its Settings row appears and toggling it changes a second window (`docs/feature-flags.md`). PR #1541 was closed unmerged; reuse its flag, kind-registry and renderer pieces only where they match spec 8.4. No `home_dispatch_turns`, `origin_terminal`, `claude_pid`, `/dispatch/jump` or `/dispatch/checkins`.

**5. Steps.** Read spec 2.3, 2.4, 7.1, 7.7, 7.23, 7.24, 7.25 and 8.4. Add the flag and its gates. Write Zod schemas in `src/shared/` with no `node:` imports. Add schema 36 with its migration next to the upgrade path and an upgraded-database test. Add route seams and stubs. Regenerate the oracle (`MISSION_UPDATE_ROUTE_SURFACE=1 node --test --import ./test/setup-state.mjs --import tsx test/route-surface-oracle.test.ts`) and confirm the diff only adds `/dispatch/*`. Add guards: Focus route entries unchanged; no import of `src/server/terminal/` or `src/server/actions.ts` from `src/mod/`, `src/cli/`, `src/server/home-dispatch/`. Add the Playwright spec following `e2e/README.md`.

**6. Data and API.** Tables and columns per spec 2.4 only, with `client_version` rather than `claude_pid`. Every route under `/dispatch/`. Unknown future fields are optional.

**7. Tests.** `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, then `npm run test:e2e` for the new spec. Upgrade-open test for schema 36.

**8. Merge and exit.** Flag off: no route, no health capability, no behavior change. Flag on: every route answers 501. The oracle diff is additive and the three guards pass.

**9. Handoff.** Later phases replace stubs and never change a stub's shape. A contract change is additive and gets its own `contract:` commit. P2 builds the CLI, mod and fakes against these schemas.

**10. Cross-phase audit.** Checked against P2 (consumes the schemas), P4, P9 and P7 (fill the stubs) and P3 (registration answer). No file is owned twice.
