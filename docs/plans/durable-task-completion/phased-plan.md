# Durable task completion - phased implementation

Implementation index for [`plan.md`](./plan.md) (approved 2026-07-24 with all dashboard
decisions resolved). Three serial phases, each a reviewable PR leaving the repository
operable.

## Incorporated decisions

| Decision | Resolution |
|---|---|
| Durable PR↔task link | **Reuse work-episode bindings** (current + historical); no `Task.prs` field |
| Cancelled task whose PR merged | **Always upgrade to `done`** (merged PRs only; closed-unmerged changes nothing; `done` never touched) |
| Multiple tasks per session | **In scope** - `Task.sessionId` = "currently executing on"; serial execution stays the invariant |
| Follow-up | Phased implementation (this document) |

## Investigated findings that shaped the phases

1. `markWorkEpisodeMerged` (db.ts:2794) already stamps `merged_at` on the **current**
   binding table but not the **historical** one - a merge observed after rollover is lost.
2. `mergedPrFor` (tasks.ts:440) reads only the current binding - the single line that
   makes `agentWentAway` mark shipped work `failed`.
3. Merge observation has two sources (pr.ts:230-292): the live-session branch poller
   (requires `acceptPrForEpisode` on the *current* episode - refuses rolled sessions) and
   a by-URL poller fed **only** by dependency URLs. A standalone task whose session died
   has no observer at all.
4. The retained `historical_task_work_episode_bindings` + `DependencyPrPollState` cadence
   machinery mean all three phases are wiring, not new infrastructure.
5. PR [#224](https://github.com/mancej/ai-harness/pull/224) reorders
   `settleMergedTask`/`closeMergedSession` (complete-then-close). It landed on `main` as
   `b4503f2` while this plan was being phased; **every phase starts from a base
   including it** (now simply: current `main`).

## Phases

| # | Phase | File | Direct prerequisites |
|---|---|---|---|
| 1 | Durable merge record and lookup | [`phase-1-durable-merge-record.md`](./phase-1-durable-merge-record.md) | - (base includes PR #224) |
| 2 | Session-independent completion reconciler | [`phase-2-completion-reconciler.md`](./phase-2-completion-reconciler.md) | Phase 1 |
| 3 | Multiple tasks per session, formalized | [`phase-3-multi-task-sessions.md`](./phase-3-multi-task-sessions.md) | Phase 2 |

## Dependency graph and concurrency

```
#224 (external, in flight)
  └─> Phase 1 ──> Phase 2 ──> Phase 3
```

Strictly serial - **no concurrency group**. All three phases edit
`src/server/tasks.ts` / `src/server/registry.ts`, and each consumes the previous phase's
contract (`mergedPrFor` → `reconcileMergedTasks` → reader audit). Merge order is the
numbering.

## Cross-phase contracts

- **`mergedPrFor(taskId)`** (from Phase 1): the newest merged PR across ALL of the task's
  bindings, or null. The only durable completion lookup; never reimplemented.
- **`markWorkEpisodeMerged`** (from Phase 1): stamps current AND historical binding rows
  in one transaction.
- **`reconcileMergedTasks()`** (from Phase 2): the single owner of PR-driven completion,
  including `failed`/`cancelled` → `done` upgrades; every completion trigger routes
  through it. Upgrades stamp dependency edges (`satisfyDependents: true`) and keep
  resources; they never register in `autoCompleted`.
- **One by-URL poll pipeline** (from Phase 2): dependency and task-completion URLs share
  `DependencyPrPollState`; no second cadence.
- **`Task.sessionId` = "currently executing on"** (from Phase 3): provenance reads
  bindings; serial invariant enforced at `agentIsFree` + `TaskManager.assign`.

## Final verification strategy

Each phase runs `npm run typecheck && npm test && npm run build` and ships through the
no-mistakes gate with CI green on Node 24 + 26. The end state is pinned by the Phase 2
headline tests (killed-session completion, cancelled upgrade, dependent unblocked, agent
freed) plus Phase 3's multi-task flow test (task A completes by merge → same session takes
task B → B's completion reads B's bindings). `task-merge-settles.test.ts` and
`task-session-orphan.test.ts` must stay green in every phase.
