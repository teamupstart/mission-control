# Phase 3: The resident loop

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

A resident runs indefinitely. After each completed turn the daemon waits the cadence from the
run's pinned profile revision (or the delay the agent asked for) and sends the loop prompt; it compacts first when context is
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
- A durable iteration log, a session-scoped spend read, and the rolling-window guardrail pause.
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
- Delivery precedent: "Pre-PR ship recovery: claim before inject" in
  `docs/agent-guides/change-contracts.md`. A delivery is claimed durably before it is sent. Only
  a positively confirmed non-delivery releases it; a success and an unknown outcome stay spent,
  because retrying uncertainty is a duplicate-send bug. `src/server/delegated-turns.ts` records
  the target transcript's byte size at send and finds the landed turn after that offset.
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
   the guardrail defaults applied to new profiles and to old revisions without the section. A
   spend cap on a harness and model that step 7 cannot price is refused at save, and again at
   launch, naming the reason. The operator either chooses a priced model or clears the cap.
2. **Persistence**:
   - `addColumn` on `resident_runs` for `loop_state` (`working`, `waiting`, `compacting`,
     `paused`), `iteration`, `last_seq`, `next_wake_at`, `consumed_generation`, `pause_reason`
     and `wake_reason`.
   - A new `resident_iterations` table with one row per wake claim: `run_id`, `seq`, `trigger`
     (`launch`, `loop` or `run_now`), `delivery` (`claimed`, `sent`, `released` or
     `unconfirmed`), `transcript_offset`, `claimed_at` and `sent_at`. It is indexed by
     (`run_id`, `claimed_at`). A partial unique index on `run_id` where `delivery` is `claimed`
     makes a second in-flight wake for one run impossible to write. The `trigger` and `delivery`
     vocabularies are append-only persisted identifiers.
   - **Two durable counters live on `resident_runs`. Neither is recomputed from rows, and
     neither ever decreases.**
     - `last_seq` is the highest `seq` ever allocated. Every claim takes `last_seq + 1`, so a
       `seq` is never reused, including after a released claim.
     - `iteration` is the number of wakes that count: rows that reached `sent` or
       `unconfirmed`. A claim does not change it. It goes up by one in the same write that moves
       a row to `sent` or `unconfirmed`. A `released` row never counts.
     - `iteration` is therefore at most `last_seq`. The difference is the number of released
       claims, plus one while a claim is in flight.
   - Rows are pruned once their `claimed_at` is more than seven days old. They exist only to count
     the rolling 24-hour window and to bind crash recovery, so pruning never changes either
     counter or the 24-hour count.
   - Upgrade test from a Phase 1 database.
3. **ResidentLoop** in `src/server/residents/loop.ts`, constructed in `src/server/index.ts` after
   SDK restore settles. It reads the loop prompt, cadence, bounds, guardrails and compaction
   settings only from the run's pinned revision (`ResidentStore.revision`):
   - **The launch turn is iteration 1.** When `ResidentManager.launch` records a run, the loop
     initializes its state with `iteration` 1 and `last_seq` 1, and appends a
     `resident_iterations` row with `seq` 1, trigger `launch`, delivery `sent`, and `claimed_at`
     and `sent_at` equal to the launch time, in the same write. A run already live when this
     phase deploys is adopted the same way, at adoption time.
   - Subscribes to Registry session upserts. When a resident session's work-cycle generation
     advances past `consumed_generation` and the driver is idle, it consumes that generation and
     schedules `next_wake_at` in one write.
   - At wake: if the session is `needs-you`, pause with that reason; if a guardrail is reached,
     pause with that reason; if `contextPct` is at or above the threshold, compact first. Then
     deliver the loop prompt through the claim below. Compaction turns and human turns are not
     iterations.
   - **Claim before send.** One write claims the wake. It is refused if the run already has a
     `claimed` row. Otherwise it:
     - increments `last_seq`;
     - appends a `resident_iterations` row with `seq` equal to the new `last_seq`, trigger
       `loop` (or `run_now` for **Run now**), delivery `claimed`, `claimed_at` set to now, and
       the target transcript's byte size as `transcript_offset` (null when it cannot be read).
     Only after that write commits is the loop prompt sent with `sendWhenIdle` and origin
     `resident`. The prompt carries a marker naming the run and `seq`, which the transcript view
     hides. A run is sending a wake exactly while it has a `claimed` row, and the partial unique
     index allows at most one.
   - **Outcome.** Each outcome is one write that moves the row out of `claimed`:
     - the driver's positive acceptance sets it to `sent`, sets `sent_at` and increments
       `iteration`;
     - a positive refusal (the driver was not idle, or rejected the turn before accepting it)
       sets it to `released`. Nothing landed, so neither counter changes, the row never counts,
       and the next claim takes a new `seq`;
     - nothing else releases a claim.
   - **Crash reconciliation** runs once SDK restore settles, for every run with a `claimed` row.
     The only evidence that a wake landed is its own marker, naming this run and this `seq`, in a
     user turn written after `transcript_offset`. Nothing else proves anything about this wake: a
     human turn, a restart continuation, `turn_in_progress` or an advanced work-cycle generation
     could each come from a different turn.
     - **With the marker**, one write sets the row to `sent`, takes the marker turn's time as
       `sent_at` and increments `iteration`, and the loop continues.
     - **Without the marker, or when `transcript_offset` is null or the transcript cannot be
       read**, the outcome is unknown and the wake is never resent. One write sets the row to
       `unconfirmed`, increments `iteration`, sets `loop_state` to `paused` with the reason "wake
       delivery unconfirmed", and raises attention. The row keeps its `claimed_at`, so it counts
       toward the rolling cap for the 24 hours after its claim.
     - After either write the run has no `claimed` row. **Resume** or **Run now** then claims the
       next wake under a new `seq`, and a later restart finds nothing to reconcile.
   - A human turn (pending-turn delivery) cancels a wake that is scheduled but not yet claimed;
     the next completed generation reschedules. A wake already claimed follows the outcome rules
     above.
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
     `node scripts/codex-app-server-bindings.mjs`. Declared in `HARNESS_CAPABILITIES`.
     Compaction is not an iteration.
   - **Probe both layers on real installations before enabling them.** For each harness, with a
     small model and a deliberately low threshold, run each layer and observe the compaction
     signal (Claude's compact boundary in the SDK stream; Codex's `contextCompaction` item):
     - the native backstop must fire at the configured threshold, not the harness default;
     - a between-iteration compaction must complete, `contextPct` must fall below the
       threshold, and only then may the loop prompt be sent.
     Save the observed event streams as fixtures for the fake-driver tests, and record the
     result in `HARNESS_CAPABILITIES`.
   - **If a layer fails its probe for a harness, stop before enabling that layer for that
     harness.** Ask the operator with `request_input` whether to ship with the remaining layer,
     or to approve a wider mechanism such as a clear plus a summary handoff. Record the answer in
     the pull request. The editor and card state exactly which layers are active for a run.
7. **Guardrails over a rolling 24 hours**: before each claim, the loop counts the run's
   `resident_iterations` rows whose `delivery` is `claimed`, `sent` or `unconfirmed` and whose
   `claimed_at` is within the 24 hours before now. `released` rows never count. It sums spend with
   `sessionSpendSince(noteKeys, now - 24h)`, added beside `automationSpendSince` in
   `src/server/db.ts`. Reaching either cap pauses the run and raises attention. Resume is accepted
   once the window has room; otherwise it is refused with the time the oldest counted row's
   `claimed_at` (or the oldest counted spend) leaves the window.
   - **Spend must be measurable for both harnesses before the cap ships.** Claude SDK turns
     arrive through `recordDriverSessionUsage` with reported cost. Codex turns are priced by
     `estimateStandardApiUsage` (`src/server/harness/codex/pricing.ts`). Verify both with
     fake-driver integration tests that assert `sessionSpendSince` totals per run, and with one
     real-installation turn per harness that shows rows appear for a resident session.
   - **Unpriced models are refused, never silently uncapped.** A profile whose model has no
     price cannot keep a spend cap (step 1).
   - **If verification shows a harness records no usable spend at all, stop** before shipping
     the spend cap for that harness. Ask the operator with `request_input` how to proceed, and
     record the answer in the pull request.
8. **Controls**: `POST /api/residents/runs/:id/pause|resume|run-now|restart`. Restart on new
   profile ends the run's session through the task lifecycle and launches the newest revision
   through `ResidentManager.launch`, resuming the same conversation only when the harness accepts
   the new launch options on resume.
9. **Browser**: loop state, iteration, next wake and wake reason on the band, card status line
   ("waiting, next in 3m"), dock rows and page. The `#/residents` page lists each live run of
   the selected profile.
   - Pause, Resume and Run now appear in the card menu, the band, the dock rows and each run row
     on that page.
   - Restart on new profile appears in the card menu, the band, the dock rows and the page when
     the run's revision is older than the profile's.
   - All four surfaces call the same run-control routes.
10. **Documentation**: loop, compaction and guardrails in `docs/residents.md`; turn origin in
    `docs/sessions.md`; `ResidentLoop` ownership in `docs/agent-guides/architecture.md`.

## Tests and verification

- Unit (`test/residents-loop.test.ts`) with injected clock and fake supervisor: one wake per
  generation, duplicate turn ends, human precedence, `needs-you` pause, compaction ordering,
  clamp of `schedule_next_iteration`, restart re-arm firing a missed wake once, and shutdown.
- Iteration tests:
  - a launch records `iteration` 1 and `last_seq` 1 with a `launch` row of `seq` 1;
  - each wake and **Run now** claims exactly one row with `seq` `last_seq + 1`, and adds one to
    `iteration` when the row reaches `sent`;
  - a positive refusal marks the row `released` and leaves `iteration` unchanged; the next claim
    takes a new `seq`, so no `seq` is ever written twice;
  - compaction and human turns add none;
  - after rows older than seven days are pruned, `iteration`, `last_seq` and the 24-hour count are
    all unchanged, including when a pruned row was `released` or `unconfirmed`.
- Delivery crash tests with injected failures at each boundary:
  - a crash after the claim commits and before the send is not resent: reconciliation finds no
    marker, the row becomes `unconfirmed`, `iteration` goes up by one, and the run pauses with
    "wake delivery unconfirmed";
  - a crash after the driver accepted and before the `sent` write is reconciled as `sent` from
    the marker after `transcript_offset`, without a second send;
  - an unrelated turn after the claim is not evidence. A human turn, and separately a restart
    continuation, is written after `transcript_offset`, sets `turn_in_progress` and advances the
    generation, but carries no marker. The row becomes `unconfirmed` and the run pauses without
    resending;
  - an unreadable transcript, or a null `transcript_offset`, reconciles as `unconfirmed`;
  - after an `unconfirmed` reconciliation, repeated restarts change nothing. A following
    **Resume**, and separately **Run now**, claims `seq` `last_seq + 1` while the `unconfirmed` row
    is kept, and the run again has exactly one `claimed` row;
  - writing a second `claimed` row for one run is refused by the partial unique index.
- Guardrail boundary tests:
  - a counted row claimed exactly 24 hours before a wake no longer counts, and one claimed 1 ms
    later does;
  - with the launch turn and 199 counted wakes inside the window (200 rows), the next wake pauses
    instead of claiming;
  - an `unconfirmed` row from a crash before delivery counts until 24 hours after its
    `claimed_at`. As the 200th row it pauses the next wake, and at its `claimed_at` plus 24 hours
    the window has room again. A `released` row never counts;
  - Resume is refused while the window is full, naming the right time, and accepted once it
    frees;
  - the same boundaries hold for spend, for both a Claude run and a Codex run;
  - a spend cap on an unpriced model is refused at save and at launch.
- Pinned-revision tests: editing the profile's cadence, bounds, caps or compaction leaves a live
  run unchanged, including after a daemon restart, until **Restart on new profile**.
- Harness probes on real installations of both harnesses, run once and saved as fixtures:
  - both compaction layers fire at the configured threshold;
  - spend rows appear for a resident session.
- Harness tests against those fixtures, and against the regenerated bindings.
- `npm run build` then `npm run smoke` (new MCP tool published).
- Playwright `e2e/specs/residents-loop.spec.ts` with fake agents: a resident loops, shows next
  wake, pauses at a cap and resumes. Pause, Resume and Run now are exercised from each of the
  card menu, the Console band, the dock and the `#/residents` page. After a profile edit, Restart
  on new profile appears on all four surfaces and is exercised from each of them.
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
- Repair round 1: loop settings come only from the pinned revision, and the rolling window is
  counted from `resident_iterations` rather than an aggregate counter.
- Repair round 2:
  - the launch turn is iteration 1 and is logged;
  - run controls reach the `#/residents` page;
  - spend is verified for both harnesses, and unpriced models are refused rather than uncapped;
  - both compaction layers are probed on real installations, with an operator gate if either
    fails.
- Repair round 3:
  - `iteration` is a durable cumulative counter, separate from the pruned rows that serve the
    24-hour cap;
  - Restart on new profile is in the card menu and is verified on all four surfaces;
  - wake delivery is claim-before-send, with crash reconciliation that never resends an
    unknown outcome.
- Repair round 4:
  - `last_seq` and `iteration` are separate counters that never decrease, so a refused wake is
    `released` without reusing its `seq` or lowering a counter;
  - the rolling cap counts `claimed`, `sent` and `unconfirmed` rows by `claimed_at`, so an
    unconfirmed wake counts for 24 hours from its claim;
  - reconciliation moves an unresolved claim to `unconfirmed` before any new claim, and a partial
    unique index keeps one in-flight wake per run;
  - only the wake's own marker after the recorded offset proves delivery.
