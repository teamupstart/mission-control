# Phase 15 (WP12): full loop and flag-off sweep

## Outcome
An automated full-loop test and a flag-off sweep prove the feature works end to end and changes nothing when off (F12, F10).

## Entry and dependencies
Phase 14, hence every other phase.

## Scope and non-goals
Spec section 6. Owns `test/home-dispatch-loop.test.ts`. Non-goals: the live walkthrough, which the owner performs and records in this pull request.

## Repository findings
Daemon-spawning tests call `ensureNativeStateLockAddon` at module scope.

## Steps
Real daemon, fake agent binaries, fake forms client, no tokens: both starts (first message and `mctl claude`) through a worker question, an answered receipt and a ready task; flag-off sweep over health, tool list, hook output, status line, tables and worker launches.

## Tests and verification
The loop test, full `npm test`, typecheck, lint, build, smoke, `npm run test:e2e` unchanged.

## Merge and exit
All green with the flag off after each merge; walkthrough steps in spec section 6 listed for the owner.

## Downstream handoff
None; alpha exit is a separate pull request (spec 1.6).

## Cross-phase audit
Tests only; no production files edited.
