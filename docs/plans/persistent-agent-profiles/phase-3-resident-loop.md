# Phase 3: The resident loop

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

A resident runs indefinitely. After each completed turn the daemon waits the profile's cadence
(or the delay the agent asked for) and sends the loop prompt; it compacts first when context is
at or above the threshold; it pauses for the human, for `needs-you`, and at its guardrails; and it
survives daemon restarts. **Pause**, **Resume**, **Run now** and **Restart on new profile** work from
the card menu, the Console band, the dock and the resident page.

## Entry criteria and dependencies

- Phase 2 merged (the band, card status line and dock rows that show loop state).

## Scope

- Profile section `loop`: loop prompt, default delay (5 min), agent bounds (1 to 60 min),
  guardrails on by default (200 iterations and $20 per rolling 24 hours, each editable or
  clearable), compaction threshold (70%) and compaction focus.
- `resident_runs` loop columns and the daemon-owned `ResidentLoop`.
- Mission MCP tool `schedule_next_iteration`.
- Two-layer compaction for Claude Code and Codex, including regenerated Codex bindings.
- Session-scoped spend read; guardrail pause.
- Run controls and their routes; loop state on the band, card, dock and page.

### Non-goals

Changing Foreman, recurring missions or work queues; Pi; terminal-runtime loops.

## Repository findings and inherited contracts

- `Registry.applyDriverEvent` normalizes `turn_done` into `turn_completed` and persists the
  work-cycle generation (`session_work_cycles`). `SdkSupervisor.sendWhenIdle()`
  (`src/server/sdk/supervisor.ts`) delivers only at an idle driver boundary.
  `PendingTurnManager` (`src/server/pending-turns.ts`) is the subscriber shape to copy.
- Restart order: SDK restore settles before discovery; a loop must re-arm only after it.
  `RESTART_CONTINUATION_PROMPT` already resumes a turn that was in flight.
- `TurnOrigin` (`src/shared/types.ts`) labels transcript turns.
- New MCP tools need `MISSION_MCP_TOOLS` and `KIND_MISSION_MCP_TOOLS`
  (`src/server/mission-mcp.ts`), argument schemas in both `src/shared/protocol.ts` and
  `src/mcp/server.ts`, and a rebuilt `dist/mcp/server.mjs`.
- `contextPct` arrives from `src/server/runtime-meta.ts` every 4 seconds for SDK sessions.
- Claude Code 2.1.310 reads `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; Codex 0.160.0 accepts
  `model_auto_compact_token_limit` and `thread/compact/start`. The generated bindings in
  `src/server/harness/codex/app-server/protocol.ts` predate the method.
- Inherited: Phase 1 registries and launch composer; Phase 2 band, card status line, dock rows
  and `residentRuns` collection.

## Implementation steps

1. **Loop section** in `RESIDENT_PROFILE_SECTIONS` and `ResidentLoopSection` in the editor, with
   the guardrail defaults applied to new profiles and to old revisions without the section.
2. **Persistence**: `addColumn` on `resident_runs` for `loop_state` (`working`, `waiting`,
   `compacting`, `paused`), `iteration`, `next_wake_at`, `consumed_generation`, `pause_reason`,
   `wake_reason`, `window_started_at`, `window_iterations`; upgrade test from a Phase 1 database.
3. **ResidentLoop** in `src/server/residents/loop.ts`, constructed in `src/server/index.ts` after
   SDK restore settles:
   - Subscribes to Registry session upserts. When a resident session's work-cycle generation
     advances past `consumed_generation` and the driver is idle, it consumes that generation and
     schedules `next_wake_at` in one write.
   - At wake: if the session is `needs-you`, pause with that reason; if a guardrail is reached,
     pause with that reason; if `contextPct` is at or above the threshold, compact first; then
     send the loop prompt with `sendWhenIdle` and origin `resident`, incrementing `iteration`.
   - A human turn (pending-turn delivery) cancels the pending wake; the next completed
     generation reschedules.
   - Restart: wakes that came due while the daemon was down fire once; paused runs stay paused.
   - Timers are `unref`'d and the service stops cleanly on shutdown.
4. **Turn origin**: append `resident` to `TurnOrigin` and label loop turns in the transcript.
5. **MCP tool** `schedule_next_iteration({ delaySeconds, reason })`: validated twice, added to
   both tool lists for kind `resident`, routed to the loop over HTTP with the signed session
   credential; clamps to the profile bounds and records `wake_reason`.
6. **Compaction**:
   - Native backstop contributor in `RESIDENT_LAUNCH_CONTRIBUTORS`: Claude child environment
     `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; Codex `-c model_auto_compact_token_limit=<n>` computed
     from the model's context window.
   - Between iterations: a per-harness `compact(focus)` capability, `/compact <focus>` as a user
     turn for Claude, `thread/compact/start` for Codex after regenerating bindings with
     `node scripts/codex-app-server-bindings.mjs`. Declared in `HARNESS_CAPABILITIES`, with
     `null` where unmeasured. Compaction is not an iteration.
7. **Spend**: `sessionSpendSince(noteKeys, sinceMs)` beside `automationSpendSince` in
   `src/server/db.ts`; the loop sums the run's sessions over the rolling window. A harness
   without recorded spend falls back to the iteration cap only, shown on the card.
8. **Controls**: `POST /api/residents/runs/:id/pause|resume|run-now|restart`. Restart on new
   profile ends the run's session through the task lifecycle and launches the newest revision
   through `ResidentManager.launch`, resuming the same conversation only when the harness accepts
   the new launch options on resume.
9. **Browser**: loop state, iteration, next wake and wake reason on the band, card status line
   ("waiting, next in 3m"), dock rows and page; Pause, Resume, Run now in the card menu, band
   and dock; Restart on new profile when the run's revision is older than the profile's.
10. **Documentation**: loop, compaction and guardrails in `docs/residents.md`; turn origin in
    `docs/sessions.md`; `ResidentLoop` ownership in `docs/agent-guides/architecture.md`.

## Tests and verification

- Unit (`test/residents-loop.test.ts`) with injected clock and fake supervisor: one wake per
  generation, duplicate turn ends, human precedence, `needs-you` pause, guardrail pause and
  window roll, compaction ordering, clamp of `schedule_next_iteration`, restart re-arm firing a
  missed wake once, shutdown.
- Harness tests: the compaction capability against the fakes, and the regenerated bindings.
- `npm run build` then `npm run smoke` (new MCP tool published).
- Playwright `e2e/specs/residents-loop.spec.ts` with fake agents: a resident loops, shows next
  wake, pauses at a cap, resumes, Run now fires, Restart on new profile appears after an edit.
- `npm run typecheck`, `npm run lint`, `npm run test:e2e`.

## Exit criteria

A resident loops, compacts and pauses as specified across a daemon restart, without
double-sending or overriding a human turn.

## Downstream handoff

The loop state machine, its columns and the MCP tool are stable; later work may read loop state
but must not send turns to a resident outside `ResidentLoop` or the existing human paths.

## Cross-phase audit record

- Depends on Phase 2 for display surfaces; adds only its own section, contributor, columns and
  routes.
- Phase 5's MCP rendering and this phase's Codex `-c` compaction override both pass through the
  contributor list; neither edits the other's contributor.
