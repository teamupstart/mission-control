# Foreman ship shepherd: phased implementation

## Source and approved decisions

Source plan: `docs/plans/foreman-ship-shepherd/plan.md`

Mission Control review `2535938c-6519-4bfc-9051-3080328e1f7e` approved:

- every invited task-owned `ship` session before its first task-owned pull request, including both
  Workflow and Straight-to-PR completion;
- structural recovery when durable state determines the next action, with one tool-less model call
  only for an ambiguous idle implementation;
- a dedicated 20-minute initial recovery threshold;
- three attempts with 20, 40, and 80 minute delays, then human escalation;
- a merge-aware phased implementation plan with dependency-linked Mission Control tasks.

There are no unresolved product choices in this phased plan.

## Repository findings

1. `src/server/task-contract.ts` already gives every dispatched `ship` task an authoritative initial
   handoff: implement and verify, but leave commit, push, pull request, and CI to Mission Control.
   The generic verifier in `src/server/foreman/worker.ts` receives only the durable objective and
   focus, so it cannot distinguish that trusted boundary from ordinary transcript text.
2. Prompted completion currently consumes a work-cycle generation for every terminal disposition,
   but `foreman_queues` retains only the consumed generation, an optional direct-shipping latch, and
   legacy intent/evidence columns. It does not retain why the generation was consumed or the
   verifier gaps that made it incomplete.
3. `planPromptedWrapup` deliberately treats the generic prompted trigger as a bystander and consumes
   an incomplete verdict without typing. That remains correct for personal and hand-started
   conversations. Recovery must therefore be a separate task-owned `ship` policy, not a global
   change that makes every prompted hold self-repair.
4. The daemon already owns the atomic prompted-consumption boundary at
   `POST /api/sessions/:id/queue/wrapup/prompted`. Workflow claims have their own daemon transaction.
   Those are the only safe places to persist a completion disposition for the same generation.
5. `src/server/foreman/review-followup.ts` is the closest automation precedent: a pure decision core,
   full-fleet observation, fresh session/config/Workflow rechecks, one instruction per pane per pass,
   and conservative unknown-delivery handling.
6. `detectStall` and `settledIdle` already define the useful quiet-session shape. The shepherd must
   consume normalized Registry state rather than add transcript polling or raw hook interpretation.
7. Open pull-request observation already reaches `Session.prState` for one repository and
   `task.repoPrs[].feedback` for attached repositories. The shepherd can extract a shared
   task-owned-open-PR predicate from the existing follow-through projection and must not add another
   GitHub poller.
8. `ForemanConfigSchema` already owns live human-facing automation knobs and defaults old config
   objects through Zod. `ForemanBar.tsx` exposes completion and PR follow-through controls, and the
   existing settings and episode ledger can carry the new permission and audit without a new page.
9. The worker is HTTP-only and the daemon is the sole SQLite writer. New recovery claims, releases,
   and episode writes must preserve that boundary.
10. The source plan's proposed outcome list has no honest value for an exhausted verifier
    infrastructure failure. Persisting that as `held` would make Phase 2 treat a missing verdict as
    blocking implementation gaps. Add append-only `verification_failed` as a separate outcome and
    escalate it rather than asking a recovery model to reinterpret an unavailable verifier.

## Sizing estimate and phase-count rationale

Estimated non-test implementation change: **1,250 to 1,750 lines**.

Assumptions behind the estimate:

- 120 to 180 lines for a shared task completion contract and verifier prompt plumbing;
- 300 to 430 lines for additive decision persistence, migration, wire projection, route schemas,
  atomic consume/claim integration, and fail-closed decoding;
- 260 to 380 lines for the pure shepherd policy, recovery prompt builder, and task-owned PR helpers;
- 300 to 430 lines for daemon claim/release routes, Foreman client methods, worker orchestration,
  backoff, and episode recording;
- 180 to 260 lines for Foreman configuration, controls, recovery visibility, and documentation.

Tests are excluded. They will be substantial because the work crosses a persisted queue projection,
two atomic completion paths, a separate worker process, multi-repository PR observation, model-call
policy, and visible dashboard controls.

Two phases are justified. Combining them would mix a high-risk correction to completion semantics
and Workflow transactions with a second automated-typing state machine, new operator permissions,
and browser behavior in a change likely exceeding 1,200 production lines. Phase 1 is independently
valuable: it fixes the reported false hold and leaves an auditable completion record while adding no
new recovery writer. Phase 2 then consumes that fixed contract and projection.

A third phase is not justified. Separating daemon recovery from its UI would merge a hidden live
automation surface, while separating the targeted-model branch would ship a shepherd that abandons
the most common ambiguous non-empty-diff stall. Phase 2 keeps policy, guarded delivery, controls,
visibility, documentation, and E2E proof as one vertical feature slice.

## Phase graph

```text
Planning artifacts merge
          |
          v
Phase 1: Explicit completion boundary and durable decision projection
          |
          v
Phase 2: Pre-PR shepherd recovery loop and controls
```

Every phase also depends directly on this planning session. That publication gate prevents a phase
from dispatching before the source plan, phased index, and phase guide exist on the default branch.

## Phase table

| Phase | Outcome | Direct implementation prerequisite | Estimated production change | Concurrency |
|---|---|---|---:|---|
| 1. Explicit completion boundary and durable decision projection | Judge task-owned ship implementation against its trusted initial handoff and durably record why each prompted generation stopped | Planning session | 500 to 720 lines | None |
| 2. Pre-PR shepherd recovery loop and controls | Re-engage eligible idle ship sessions with state-specific bounded recovery, visible controls, audit, and escalation | Phase 1; planning session | 750 to 1,030 lines | None |

## Merge order

1. Publish and merge these planning artifacts.
2. Phase 1 starts from the resulting default branch, lands the completion contract and durable
   disposition atomically, and merges after migration and completion-regression tests pass.
3. Phase 2 starts from Phase 1's merged schema and decision vocabulary, adds the live recovery loop
   and its dashboard surface, and merges only after unit, worker, browser, build, and smoke gates pass.

There is no concurrency group. Phase 2 directly consumes Phase 1's persisted projection and trusted
completion boundary.

## Cross-phase contracts

- Phase 1 owns the `TaskCompletionContract` registry, completion-outcome vocabulary, queue projection,
  migration, atomic disposition writes, and verifier contract. Phase 2 consumes those names and may
  not create a parallel completion ledger or reinterpret task handoff prose from transcripts.
- The trusted initial boundary applies only to task-owned `ship` sessions. Generic prompted
  completion remains a bystander for personal sessions and other task kinds.
- `verification_failed` is distinct from `held`. Only a model-produced incomplete verdict with
  bounded blocking gaps is a held implementation decision.
- A completion disposition is written in the same daemon transaction that consumes the generation
  or claims the Workflow. No worker-side sequence may create a consumed generation with a missing
  current disposition.
- Missing, partial, unknown, or malformed disposition state fails closed. Old rows remain readable
  with no current decision and become eligible for recovery only through Phase 2's current-state
  gates.
- Phase 2 owns recovery markers, attempt claims, next-at times, delivery outcome, and exhaustion.
  Recovery state is additive beside Phase 1's decision and cannot rewrite the decision it acts on.
- Foreman remains HTTP-only. The daemon remains the only SQLite writer and the only authority that
  validates a recovery claim against current task, session, queue, work-cycle, Workflow, and PR state.
- The existing GitHub observer remains the only remote PR reader. Absence checks cover every
  task-owned repository projection, not only `Session.prState`.
- Existing queue drain, Workflow resumption, parked-run attention, review follow-through, and human
  input ownership retain precedence. One worker pass may deliver at most one Foreman instruction to
  a session.
- The first wait is the configured `shipRecoveryMinutes`, defaulting to 20. Later attempts use fixed
  40- and 80-minute delays. A fourth due event escalates and never types.
- Unknown injection outcomes remain claimed. Only a daemon-confirmed non-delivery may release an
  attempt for retry.
- A context-key rotation, task terminalization, task/session rebinding, new work-cycle generation,
  observed open PR, or resumed activity makes an older recovery claim inert.

## Final verification strategy

Both phases run focused files with the mandatory test preload, then `npm run typecheck` and
`npm run lint`. Phase 1 runs queue migration, prompted-worker, Workflow completion, and repair-cycle
coverage plus the full unit suite. Phase 2 runs the full unit suite, `npm run build`, `npm run smoke`,
and the relevant Playwright specs because worker, protocol, browser, and built runtime surfaces all
change.

The final audit must prove:

- an objective may require a pull request while the trusted initial `ship` contract correctly marks
  implementation complete and creates exactly one Workflow claim;
- each consumed prompted generation carries one readable disposition, including old-row and
  malformed-row behavior;
- a held decision survives restart and produces one targeted gap turn only after 20 quiet minutes;
- structural empty-diff and direct-handoff recovery avoid model spend, while only the ambiguous
  non-empty-diff branch invokes the tool-less recovery reviewer;
- active work, queue ownership, pending turns, human asks, Workflow ownership, any task-owned open
  PR, off/disabled mode, missing invite, and off-allowlist state all suppress delivery;
- new activity or generation change invalidates a stale attempt, uncertain delivery does not retry,
  and attempts occur at 20, 40, and 80 minutes before visible human escalation;
- multi-repository tasks stop shepherding when any task-owned repository has an observed open PR;
- the master toggle, threshold, session drawer, and fleet ledger show the same daemon-owned state;
- no worker pass sends both pre-PR recovery and PR follow-through to one pane.

## Cross-phase audit record

- Initial audit: every approved decision is assigned. Phase 1 owns completion truth and disposition;
  Phase 2 owns recovery, three-attempt timing, controls, visibility, and escalation.
- Compatibility audit: Phase 1 adds no new automated typing. Existing generic prompted holds remain
  quiet, while task-owned ship verification becomes consistent with the handoff already delivered.
- Dependency audit: Phase 2 directly consumes Phase 1 and cannot run concurrently. Both phases have
  the planning-session publication edge.
- Discrepancy audit: the append-only `verification_failed` outcome resolves the source plan's missing
  representation for verifier infrastructure exhaustion without changing an approved product choice.
- Phase-count audit: two phases are the fewest coherent merge units. No test-only, documentation-only,
  UI-only, or cleanup phase exists.
- Final full-set audit: Phase 2 consumes Phase 1's exact task contract, outcome, generation, and gap
  projection. No requirement depends on undocumented cleanup, no concurrent phases share mutable
  contracts, and the final state preserves one daemon writer, one PR observer, and one instruction
  per pane per pass.

## Phase documents

- `docs/plans/foreman-ship-shepherd/phase-1-explicit-completion-and-decision-projection.md`
- `docs/plans/foreman-ship-shepherd/phase-2-pre-pr-shepherd-and-controls.md`
