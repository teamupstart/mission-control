# Phase 1 (WP1): contracts, flag, stubs, fakes

## Outcome
The `headless-mode` preview flag exists and every contract later phases build on is on `main`, with nothing visible while the flag is off (F1).

## Entry and dependencies
Planning session merged. No other phase.

## Scope and non-goals
In scope: spec WP1 card (8.3), sections 2.3, 2.4, 3, 7.1, 7.18. Registry entry exactly as in 7.1; all shared schemas in `src/shared/home-dispatch*.ts`; schema 35 in `migrate()` (additive, bump `CURRENT_DATABASE_SCHEMA_VERSION` from 34); route stubs under `/mcp/dispatch/*` behind one `requireFeature` (501 while on); six MCP tool stubs and `registerHomeDispatchTools`; `/api/health` capability; `mctl` registry, `bin.mctl` and build scripts; fakes in `test/helpers/home-dispatch-fakes.ts`; flag-off tests. Non-goals: any real behavior.

## Repository findings
Registry is empty today; `src/cli/` does not exist; `bin` has only `mission-control`.

## Steps
Follow spec 8.3 WP1 and 8.1 rule 1 in order: registry entry, contracts, migration, routes and tools stubs, CLI skeleton and build, fakes, tests. Call out the ungated items (migration, build outputs, registry entry) in the pull request (7.1).

## Tests and verification
`test/home-dispatch-flag.test.ts` (flag off and on, live toggle, no writes while off); full suite; `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`; Settings row browser check if the panel exists.

## Merge and exit
Flag off: health, MCP tool list, hook output and worker launches byte-identical. Existing e2e specs pass.

## Downstream handoff
Later phases replace stubs and never change their shape; contract additions are optional fields in `contract:` commits. Hot files in 8.1 rule 6 stay owned by their listed phase.

## Cross-phase audit
Consistent with phases 2 to 15: all contracts are owned here, no later phase edits `db.ts`, `routes.ts`, `mcp/server.ts` or `mission-mcp.ts`.
