# Phase 2 (WP2a): sessions, turns, launcher, intent

## Outcome
The daemon registers home sessions from the hook route, logs turns, decides when to show the launcher once per new interactive session, and detects run-now or schedule intent (F3, F4, F10, F16 parts).

## Entry and dependencies
Phase 1.

## Scope and non-goals
Spec 7.2, 7.3 (daemon side), 7.4, 7.9 (turns), 7.20 (detector and nudge). Owns `src/server/home-dispatch/sessions.ts, turns.ts, launcher.ts, hook-output.ts, intent.ts`. Non-goals: the hook script itself (phase 6), inbox, drafts.

## Repository findings
Hook route `/hooks/:event` gains dispatch work only while `featureEnabled("headless-mode")`; the single call into `hook-output.ts` from the route was seamed in phase 1.

## Steps
Implement per the sections above: registration schema, refuse workers (D16), launcher once per startup, never on resume, clear, compact or non-interactive (D17, D19), 120-char turn excerpts, 7-day cleanup through `onFeatureFlagsChanged`.

## Tests and verification
`home-dispatch-launcher`, `-turns`, `-workers`, `-intent` tests with flag-off and flag-on cases; typecheck, lint, suite.

## Merge and exit
Flag off: no dispatch field, no table writes. Stubs replaced without shape change.

## Downstream handoff
Phases 6, 7, 12 rely on session and turn APIs and the `dispatch` hook output shape.

## Cross-phase audit
No overlap with phase 3 (inbox, approval) or phase 4 (drafts); shares only phase 1 contracts.
