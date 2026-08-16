# Durable work-cycle completion: phased implementation

## Source and approved decisions

Source plan: `docs/plans/automatic-completion-work-cycles/plan.md`

The human approved the durable work-cycle approach and explicitly chose phased backlog scheduling.
The approved decisions are:

- replace prompted intent-revision re-arming rather than keep a permanent parallel fallback;
- retain intent reconciliation, evidence fingerprints, the verifier, settled-idle gating, queue drain,
  workflow claims, Ask, direct wrap-up, and fail-closed behavior;
- let the already-running tactical incident task land first, then rebase and replace its narrower
  trigger mechanism while retaining valid coverage;
- schedule every implementation phase disabled, at low priority, using Codex `gpt-5.6-sol` with
  `xhigh` effort.

There are no unresolved product choices in this phased plan.

## Repository findings

1. `src/server/foreman/prompted-wrapup.ts` keys both the once-only check and incomplete hold to the
   resolved intent episode. Its stated assumption that nothing changes until another human prompt is
   false for background continuations.
2. `src/server/harness/claude/scaffolding.ts` correctly removes machine
   `<task-notification>` blocks from human goal capture. Lifecycle normalization must not weaken that
   intent boundary.
3. Terminal adapters already translate `Stop` to idle, and SDK `turn_done` is documented as the same
   fact in `Registry.applyDriverEvent`. The missing layer is a durable generic completed-turn identity.
4. `settledIdle` in `src/shared/session.ts` is already the shared ordering guard for late
   `PostToolUse` and multi-turn pauses. The new token complements it rather than replacing it.
5. `session_events` is written only by `applyHook`, never pruned, and queried as "any row means hooks
   were seen." Writing SDK turns there would silently change hook-capability semantics.
6. `session_work_episodes` owns task, agent identity, branch, and pull-request provenance. Reusing it
   for turn generations would overload a task-level ownership contract with a different lifecycle.
7. Workflow claims already create or resume a run and retire a Foreman guard in one transaction.
   That transaction is the correct place to consume an expected completion generation.
8. The prompted worker rechecks resolved intent after verification but does not recheck idle state or
   a completed-turn marker. The cutover must close that stale-verdict window.
9. Workflow repair resumption already demonstrates the preferred philosophy: daemon-observed state
   and repository evidence, not an agent self-report. Prompted delivery currently clears
   `prompted_goal` explicitly because no natural turn-generation re-arm exists.
10. The scheduled tactical task `5439ebd4-e346-4d57-b778-ecb2ebec8e67` is already running in a
    separate worktree. Phase implementation must begin from its merged result or record why it was
    superseded.

## Sizing estimate and phase-count rationale

Estimated non-test implementation change: **420 to 650 lines**.

Assumptions behind the estimate:

- 70 to 120 lines for shared lifecycle types and harness normalization;
- 80 to 140 lines for additive SQLite storage, migration, and accessors;
- 90 to 150 lines for Registry state transitions, restart projection, and session exposure;
- 140 to 220 lines for prompted selection, worker currency checks, failure tracking, and atomic
  consume paths;
- 40 to 80 lines for workflow delivery cleanup and behavior documentation.

Tests are excluded from this estimate and will be substantial because terminal hooks, SDK turns,
migration compatibility, worker timing, and workflow claims each need focused coverage.

Two phases are justified. Combining them would ask one change to establish a new cross-harness
durable lifecycle contract while simultaneously replacing a high-risk shipping trigger and its
workflow transaction, after rebasing an incident fix that is currently in flight. Keeping the
foundation separate makes its normalization, duplicate suppression, restart behavior, and migration
reviewable without changing automatic completion. Phase 2 can then consume a fixed tested contract
and focus on exactly-once action semantics. A third cleanup phase is not justified because leaving a
temporary dual trigger merged would create the competing source of truth the plan rejects; cutover,
migration, documentation, and legacy-path removal stay together in Phase 2.

## Phase graph

```text
Running tactical fix 5439ebd4-e346-4d57-b778-ecb2ebec8e67
                              |
                              v
Phase 1: Durable work-cycle foundation
                              |
                              v
Phase 2: Prompted completion cutover
```

Every phase also depends directly on this planning session so its referenced documents must merge to
the default branch before the phase can be released. Both implementation tasks remain disabled after
that dependency is satisfied.

## Phase table

| Phase | Outcome | Direct implementation prerequisite | Estimated production change | Concurrency |
|---|---|---|---:|---|
| 1. Durable work-cycle foundation | Persist and expose a generic completed-turn generation for terminal and SDK sessions without changing Foreman behavior | Tactical fix task `5439ebd4-e346-4d57-b778-ecb2ebec8e67`; planning session | 240 to 390 lines | None |
| 2. Prompted completion cutover | Replace intent/evidence re-arming with generation consumption and remove the prompted workflow reset | Phase 1; planning session | 180 to 300 lines | None |

## Merge order

1. The tactical incident fix merges or is explicitly superseded.
2. Phase 1 rebases on the resulting default branch, opens one reviewable pull request, and merges only
   after its lifecycle and migration tests pass.
3. Phase 2 starts from Phase 1's merged contract, opens one reviewable pull request, and completes the
   behavioral replacement.

There is no concurrency group. Phase 2 consumes Phase 1's schema, Registry projection, and normalized
event contract directly.

## Cross-phase contracts

- Phase 1 owns the generic work-cycle vocabulary, persistence schema, Registry transition rules, and
  exposed read shape. Phase 2 must consume those definitions and must not add a second turn detector.
- A generation advances only after work was observed and a normalized turn end arrives. Idle
  notifications and duplicate ends without intervening work do not advance it.
- The persisted state is current-state projection, not an append-only activity log. Several completed
  turns while Foreman is offline coalesce to the latest generation.
- Raw harness event strings remain inside harness adapters. Generic consumers use normalized state.
- Phase 1 does not change prompted behavior. This keeps its merge operable and makes rollback safe.
- Phase 2 owns the queue guard migration, atomic generation consumption, post-verifier currency check,
  failure-tracker rekey, workflow delivery simplification, and prompted behavior documentation.
- Queue drain remains authoritative when queue items exist. Neither phase changes queue-drain state or
  its workflow re-arm.
- Evidence fingerprints remain proof and idempotency material, not the lifecycle trigger.
- No permanent legacy fallback remains after Phase 2. Compatibility data may remain stored, but only
  the work-cycle generation drives new prompted checks.

## Final verification strategy

Each phase runs its focused files with the repository's required test preload, followed by
`npm run typecheck` and `npm run lint`. Phase 1 also runs database isolation and migration coverage.
Phase 2 runs the real prompted-worker integration test, workflow repair-cycle and Foreman-claim tests,
the full unit suite, `npm run build`, and `npm run smoke` because the worker and runtime contracts
change. No UI changes are planned, so no new Playwright browser spec is required unless implementation
changes a visible surface despite the stated non-goal.

The final behavior audit must prove:

- one background continuation under unchanged intent produces one later verification and no duplicate
  claim;
- idle noise and duplicate turn ends do not re-arm;
- work beginning during verification discards the stale result;
- consumed and unconsumed generations recover correctly across restarts;
- terminal Claude, terminal Codex, and supported SDK runtimes satisfy the same contract;
- queue-backed sessions remain drain-owned;
- workflow repair delivery naturally re-arms through the later completed turn;
- empty diff and verifier failure paths retain their current cost and no-hot-loop properties.

## Cross-phase audit record

- Initial audit: every approved source-plan requirement is assigned. Phase 1 owns only the lifecycle
  fact; Phase 2 owns the behavioral replacement. No requirement is deferred to an undocumented cleanup.
- Dependency audit: Phase 2 directly consumes Phase 1 and cannot run concurrently. The tactical fix is
  a direct entry dependency of Phase 1 so its coverage and implementation are visible before the new
  contract is built.
- Compatibility audit: the split leaves the repository operable after Phase 1 because no consumer is
  switched early. Phase 2 performs migration and cutover together so no merged state has two active
  prompted triggers.
- Final full-set audit: Phase 2 consumes Phase 1's logical key, generation, persistence accessor, and
  restart semantics without redefining them. Every source requirement is owned once, the direct
  dependency direction is acyclic, there is no false concurrency claim, and the final state removes
  the legacy trigger while retaining its compatibility data.
- Scheduling audit: both phase tasks will depend on this planning session, Phase 1 also depends on the
  running tactical task, and Phase 2 depends directly on Phase 1. Disabled state, low priority,
  Codex `gpt-5.6-sol`, and `xhigh` effort are task properties to verify after creation.

## Phase documents

- `docs/plans/automatic-completion-work-cycles/phase-1-durable-work-cycle-foundation.md`
- `docs/plans/automatic-completion-work-cycles/phase-2-prompted-completion-cutover.md`
