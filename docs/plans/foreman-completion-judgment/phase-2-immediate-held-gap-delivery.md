# Phase 2 - Immediate held-gap delivery for managed ship tasks

## Outcome

A managed ship task whose completion is held with real gaps learns about them in the same
worker pass - seconds after the verdict - instead of after the ship shepherd's 20-minute
quiet window. Cycle latency for a responsive session drops from ~23 minutes to about one
pass. Human-driven sessions keep exactly today's silence.

## Entry criteria and dependencies

- Direct prerequisite: Phase 1 merged. The fallback claim changes which holds still reach
  this delivery branch, and both phases edit `processPromptedWrapup`.

## Scope and non-goals

In scope: extracting the shepherd's delivery plumbing into a shared helper, the new
in-pass delivery branch on the prompted hold path, and its gating.

Non-goals: no change to the shepherd's thresholds, backoffs, or policy
(`decideShipShepherd` stays as the backstop, unchanged); no change to attempt keying or
persisted shapes (Phase 3); no new payload wording - the existing, reviewed
`structuralPayload` text is reused; no new config knob (adopted decision: the existing
`keepShipTasksMoving` flag governs both delivery routes).

## Repository findings this phase builds on

- The hold is written by `consumePromptedCycle` with `outcome: "held"` and its blocking
  gaps (`src/server/foreman/worker.ts:2144-2157`); today nothing is typed afterward - the
  "bystander" rationale is documented at `src/server/foreman/prompted-wrapup.ts:309-320`
  and is correct only for sessions a human is driving.
- The shepherd's per-session delivery sequence lives in `runShipShepherd`
  (`src/server/foreman/worker.ts:1068-1319`): daemon recovery claim (`worker.ts:1212`),
  a full pre-inject re-check of ownership, cycle, marker, and delivery state
  (`worker.ts:1244-1273`), the inject (`worker.ts:1284`), delivery resolution
  (`worker.ts:1304`), and the episode audit (`recordShipRecovery`,
  `worker.ts:1435-1501`, situation `ship-recovery`).
- The shepherd's eligibility policy is `decideShipShepherd`
  (`src/server/foreman/ship-shepherd.ts:93-210`); its gates other than the 20-minute
  `settledIdle` are the correct gates for immediate delivery too: `keepShipTasksMoving`
  on, a running managed ship task, Foreman invited, drivable and hook-instrumented, pane
  available, no human owner, no queue items or pending turns, no active workflow owner,
  no task-owned open PR, `mayActLive`.
- The `held_gaps` payload is `structuralPayload` (`ship-shepherd.ts:237-243`).
- Attempt accounting is daemon-owned `PromptedRecoveryState`
  (`src/shared/types.ts:1449`), claimed via the recovery-claim endpoint; the worker never
  counts attempts itself. `nudgedThisPass` (`worker.ts:505`) prevents double-typing into
  one session within a pass.

## Implementation steps

1. **Extract the delivery helper** (`src/server/foreman/worker.ts`): factor the
   claim -> re-check -> inject -> resolve -> record sequence out of `runShipShepherd` into
   one function both callers use, parameterized by the recovery candidate (task, logical
   key, generation, reason, attempt basis, payload, marker). Behavior of the shepherd path
   must be byte-identical - this step is a refactor, pinned by the existing shepherd
   tests.

2. **Immediate-delivery branch**: in `processPromptedWrapup`, after a `hold` outcome is
   successfully consumed with blocking gaps, evaluate immediate eligibility using the same
   inputs `runShipShepherd` resolves (share the resolution rather than re-deriving it):
   every `decideShipShepherd` gate except the quiet window, which is satisfied by
   construction - the verdict just arrived. Build the `held_gaps` recovery candidate from
   the decision just written, claim it with the daemon exactly as the shepherd does, and
   deliver through the shared helper. Mark the session in `nudgedThisPass`.

3. **No double delivery**: the daemon claim is the idempotency point - the shepherd's
   later pass sees `lastDelivery: "delivered"` and `nextEligibleAt` on the same recovery
   state and does not re-send (existing `ship-shepherd.ts:154` behavior). Add nothing new.

4. **Silence preserved where it belongs**: the branch runs only when the session has a
   running managed ship task. A session with no task, a non-ship task, a human owner, or
   `keepShipTasksMoving` off gets today's exact behavior - consume and stay silent.

5. **Documentation**: the same docs page updated in Phase 1 gains the delivery-timing
   change: immediate on hold for managed ship tasks, 20-minute shepherd as backstop.

## Data, API, and compatibility

- No persisted-shape changes. The recovery claim, state machine, markers, and backoffs
  are used as-is; only the moment of first delivery moves.
- The recovery-claim endpoint is called from a second worker call site with identical
  semantics; no route changes.

## Tests and verification

- `test/foreman-ship-shepherd.test.ts`: unchanged policy tests keep passing (backstop
  intact); the extraction refactor changes no decision.
- `test/prompted-wrapup-worker-e2e.test.ts`: a held managed ship completion receives the
  gap payload in the same pass, one recovery attempt is recorded, and one `ship-recovery`
  episode is written; a second pass on the same generation sends nothing; a held
  human-driven (task-less) session receives nothing; `keepShipTasksMoving: false` receives
  nothing and the shepherd backstop still fires later; a session with pending turns or a
  task-owned open PR is skipped.
- `test/ship-recovery-http.test.ts`: claim endpoint behavior from the new call site.

Run:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/foreman-ship-shepherd.test.ts test/prompted-wrapup-worker-e2e.test.ts test/ship-recovery-http.test.ts
npm run typecheck
npm run lint
npm test
```

## Merge and exit criteria

- All verification above passes; the pull request is reviewable and merged.
- With only Phases 1-2 merged the repository is fully operable: holds are delivered
  in-pass, the shepherd remains the backstop, and attempt accounting still keys on the
  generation (Phase 3's concern) without any regression from today.

## Downstream handoff

Phase 3 may rely on: the shared delivery helper as the single delivery entry point, and
the fact that every delivery - immediate or shepherd - passes through one daemon recovery
claim (contract C3). It must not add a second delivery path or a worker-side attempt
counter.

## Cross-phase audit record

- 2026-08-24: written after Phase 1; ordered serially behind it (same function edited,
  and Phase 1's fallback reduces the held set this phase delivers).
- 2026-08-24: confirmed against Phase 3's draft - the shared helper's candidate shape
  carries the fields Phase 3 needs to add episode continuity without reshaping the helper.
