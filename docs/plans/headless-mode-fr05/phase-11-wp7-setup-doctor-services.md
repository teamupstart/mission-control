# Phase 11 (WP7): setup, doctor, services

## Outcome
`mctl setup` turns the flag on and installs missing owned pieces, `mctl setup --service` installs the daemon and Foreman LaunchAgents, `mctl doctor` reports fixes (F2).

## Entry and dependencies
Phases 6, 9 and 8. Merge gated by spike S5.

## Scope and non-goals
Spec 7.14. Owns `commands/setup.ts, doctor.ts`, `scripts/install-service.mjs`, and the MCP registration module moved out of `src/main/integrations.ts`. Non-goals: second installers of any kind (rule 3.3).

## Repository findings
Foreman is started only by the app today (L25); launchd needs print, bootout, wait, bootstrap (L18); new OS paths go in `FIXED_OS_EXECUTABLES` and `CHILD_PROCESS_BOUNDARIES`.

## Steps
Idempotent setup via the existing installers, flag toggle through `PUT /api/feature-flags`, `--off` removes nothing the app owns, user's own hooks and status line untouched, Foreman label with the flag value passed from the daemon (the worker never reads SQLite).

## Tests and verification
`home-dispatch-setup.test.ts`, `install-service.test.ts` with temp HOME and fake runners asserting planted files byte-identical; suite, typecheck, lint.

## Merge and exit
Second run changes nothing; doctor changes nothing. S5 recorded or fallback applied.

## Downstream handoff
Phases 12 and 14 assume these commands.

## Cross-phase audit
`install-service.mjs` owned only here.
