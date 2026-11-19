# Phase 12 (WP10): follow and drop in

## Outcome
Home-dispatched tasks run in a pane in the person's tmux or herdr, `mctl pick` lists workers live and jumps in and back, and `mctl claude` sets up the workspace (F8).

## Entry and dependencies
Phases 2, 10, 11 and 5.

## Scope and non-goals
Spec 7.16. Owns the runtime rule in `src/server/harnesses.ts`, the one runtime call site in `dispatcher.ts`, `commands/pick.ts`, `home-dispatch/jump.ts`, `mux-mirror.ts`, and the tmux and herdr adapter changes. Non-goals: editing tmux or herdr config files or typing into panes.

## Repository findings
Dashboard tasks keep their runtime (D21); mirror and heartbeat subscribe through `onFeatureFlagsChanged`.

## Steps
Terminal runtime only for home-dispatched tasks, `POST /mcp/dispatch/jump`, key table that exists only in Mission Control-created sessions, herdr sidebar mirror, `mctl claude` workspace session `mission-control`.

## Tests and verification
`home-dispatch-follow`, `-pick`, `-mux-mirror` tests with fake tmux and herdr; suite, typecheck, lint.

## Merge and exit
Flag off: runtime unchanged; user config files byte-identical.

## Downstream handoff
Phase 13 adds subagent lines to the picker.

## Cross-phase audit
`dispatcher.ts`: composition is phase 5's, only the runtime call site here.
