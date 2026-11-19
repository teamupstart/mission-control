# Phase 8 (WP6a): mctl client and reads

## Outcome
`mctl get`, `describe`, `logs -f`, `status` and `config view` show home-dispatched tasks, following via the event stream (F6).

## Entry and dependencies
Phase 3.

## Scope and non-goals
Spec 7.13 read side. Owns `src/cli/client.ts` and `commands/get.ts, describe.ts, logs.ts, status.ts, config.ts`. Non-goals: `run`, `claude`, `setup`.

## Repository findings
`src/cli/` and its registry come from phase 1.

## Steps
Client with token and daemon discovery; read commands; while the flag is off every command except `setup` and `doctor` exits 2 with `headless-mode is off: run mctl setup`; bad input exits 2 listing valid choices; never poll.

## Tests and verification
`home-dispatch-cli.test.ts` via spawnSync and injected streams; suite, typecheck, lint, smoke of built `mctl`.

## Merge and exit
Matches dashboard data for home-dispatched tasks.

## Downstream handoff
Phases 10 and 11 reuse the client.

## Cross-phase audit
Command registry owned by phase 1; files here are leaf commands only.
