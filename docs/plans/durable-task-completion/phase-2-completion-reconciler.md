# Phase 2: Session-independent completion reconciler

## Outcome

Any retained task whose durable record shows a merged PR reaches `done` without a live
session or episode currency, **upgrading `failed`/`cancelled` rows** (adopted decision 2).
A live agent still executing a `running`/`dispatching` task stays under the narrower
idle-and-current-episode rule, because its merge may be intermediate. Standalone tasks
whose sessions are gone get their PRs polled by URL, so their merges are observed at all.

## Entry criteria and dependencies

- **Depends on Phase 1** (`phase-1-durable-merge-record.md`): `mergedPrFor` reads
  current + historical bindings, and `markWorkEpisodeMerged` stamps both tables. This
  phase's reconciler is a consumer of that contract and must not reimplement either half.
- Same merge-awareness note as Phase 1 regarding PR #224: base includes it.

## Scope

1. **By-URL polling for task-bound PRs (`src/server/registry.ts` + `src/server/pr.ts`).**
   Extend the URL harvest that feeds the existing by-URL poller (originally only
   `dependencyPrPollTargets`) with a task-completion harvest: for every task in
   `running` / `dispatching` / `failed` / `cancelled`, collect `prUrl` from its current
   binding and `historicalTaskWorkEpisodeBindingsForTask` rows where `mergedAt === null`.
   Reuse the shared `PrUrlPollState` cadence so a URL is polled at its existing rate - do
   not add a second cadence. A URL already merged in the record is never re-polled (its
   `mergedAt` is stamped; harvest excludes it).
2. **Route observed merges through the existing attribution.** When the by-URL lookup
   reports `merged`, `reconcilePrMerges` re-reads the owning binding and calls
   `reconcileWorkEpisodeMerge` with the **binding's own episode tuple**, so
   `markWorkEpisodeMerged` (Phase 1) stamps the durable record. Do not invent a parallel
   recording path.
3. **The completion reconciler (`src/server/tasks.ts`).** One method on `TaskManager`,
   e.g. `reconcileMergedTasks()`: for each task in `running` / `dispatching` / `failed` /
   `cancelled`, if `mergedPrFor(task.id)` returns a URL, move the task to `done`, except
   that a `running`/`dispatching` task whose agent is still present stays under
   `settleIfEpisodeFinished`:
   - via the existing `complete(id, `merged ${url}`, url, /* satisfyDependents */ true)`.
     `satisfyDependents: true` is deliberate: dependency edges carry their own
     `satisfiedAt` precisely because terminal rows are eventually pruned - completing
     without stamping edges re-blocks dependents later (see `satisfyDeclaredEdgesTo`'s
     doc).
   - `failed`/`cancelled` → `done` is the adopted upgrade-all decision: only a **merged**
     PR upgrades; a closed-unmerged PR changes nothing; `done` rows are never touched;
     the upgrade clears `error`, records the PR as `outcome`/`outcomeUrl`, and **keeps
     worktree/home** untouched (`complete` already keeps resources - preserve that).
   - The upgrade is **not** registered in `autoCompleted`: `reopenIfWorkResumed` exists
     to reverse an *idleness inference*, and this completion is evidence-based (the PR
     merged). A session typing again must not resurrect a task whose work landed.
4. **Wire the signals.** Run `reconcileMergedTasks()`:
   - after each PR poll tick that observed any merge (the natural home: right after
     `reconcilePrMerges` in `pollAndReconcilePrs`, or via a registry event the manager
     subscribes to - pick whichever keeps "Foreman never touches the DB" and "the
     Registry stores, the TaskManager decides" intact, per the `task_pr_merged` comment);
   - in the existing `session_upsert` listener (beside `settleIfEpisodeFinished`);
   - in `reconcileTasksBoundTo` / `reconcileTasksWithNoLiveSession` (before
     `agentWentAway`, so a merged task completes rather than failing when its session
     vanishes - `agentWentAway` keeps its own `mergedPrFor` check as the belt);
   - once at startup after the first completed discovery sweep (`onSessionsObserved`
     already fires there).
   No new timer: the PR poller's tick IS the periodic backstop.

## Non-goals

- No changes to session-close (`closeMergedSession` stays as #224 leaves it).
- No `Task.sessionId` semantics or multi-task audit (Phase 3).
- No UI beyond what falls out of status changes (the card already renders `done`).
- No polling of PRs for `done`/`backlog` tasks.

## Repository findings this phase rests on

- The by-URL poller and its cadence live in `src/server/pr.ts` (`PrUrlPollState`,
  `queryPrUrl`) and collect both `registry.dependencyPrPollTargets()` and
  `registry.taskPrPollTargets()`; merges flow to `registry.reconcilePrMerges(mergedUrls)`.
  This phase widened the harvest and the routing, not the mechanism.
- `blockersIn` (`@shared/backlog.ts`) treats `failed`/`cancelled` as a `stopped` blocker
  and clears only on `done` - the upgrade is what unblocks dependents.
- `agentIsFree` refuses a session with a `running`/`dispatching` task - completion is what
  frees the agent. No change needed there.
- `complete()` (tasks.ts:1461) keeps `sessionId` and resources; `cancel()` sets
  `cancelled`. Confirm what `cancel` does to `sessionId` and preserve display sanity on
  upgrade (Phase 3 owns the semantics; here just don't regress it).

## Implementation steps (execution order)

1. `src/server/registry.ts`: add `taskPrPollTargets()`, returning the URLs the shared
   poller needs; wire it into `pollAndReconcilePrs` beside `dependencyPrPollTargets`,
   deduplicating URLs across the two.
2. `src/server/pr.ts`: route merged results through the single `reconcilePrMerges` entry
   point, which re-reads each binding and passes its episode tuple to
   `reconcileWorkEpisodeMerge`.
3. `src/server/tasks.ts`: implement `reconcileMergedTasks()` per scope 3; wire signals
   per scope 4.
4. Tests (new `test/task-completion-reconciler.test.ts` + additions):
   - killed session + merged PR on a historical episode → task `done`, not `failed`;
   - `cancelled` task + later-observed merged PR → `done`, outcome carries the URL;
     resources untouched;
   - `cancelled` task + closed-unmerged PR → stays `cancelled`;
   - `failed`-for-no-outcome → `done` on merge observation;
   - a dependent task's blocker clears (edge `satisfiedAt` stamped) and
     `agentIsFree` passes for the freed session;
   - upgraded task is NOT reopened by `reopenIfWorkResumed` when its session works again;
   - `done` rows untouched by the reconciler;
   - harvest excludes already-merged bindings and `done`/`backlog` tasks.

## Compatibility

- `task_pr_merged` event consumers (settle/close) are unchanged; the reconciler is
  additive and idempotent (a second pass over a `done` task is a no-op).
- Foreman reads tasks over HTTP only; a task flipping to `done` is the same transition it
  already handles from `complete`.

## Verification

```sh
npm run typecheck && npm test && npm run build
```

## Merge / exit criteria

- The four headline tests (killed-session, cancelled-upgrade, closed-unmerged-stays,
  dependent-unblocks) green on CI.
- No second by-URL cadence: one `PrUrlPollState`-backed pipeline serves both
  dependency and task-completion polling.

## Downstream handoff

Later phases may rely on:
- `reconcileMergedTasks()` as the single owner of PR-driven completion, including
  terminal upgrades; Phase 3 must route any new completion trigger through it.
- The task-completion URL harvest existing and excluding merged/terminal-done rows.
Later phases must not add a competing completion path or a second poller.

## Cross-phase audit record

- 2026-07-24: initial version, audited against Phase 1: consumes `mergedPrFor` and
  `markWorkEpisodeMerged` as contracts; the historical-binding deletion audit item from
  Phase 1 matters here (the harvest reads historical rows - Phase 1's chosen
  rule must leave unmerged-but-open URLs readable until terminal `done`).
- 2026-07-25: implemented. Six decisions worth carrying into Phase 3:
  - **A `running`/`dispatching` task whose agent is STILL on the process table is
    skipped**, and left to `settleIfEpisodeFinished`. The initial scope read as "complete
    any of the four statuses on merged evidence", which would have erased the asymmetry
    Phase 1 documented and `task-merge-settles.test.ts` pins ("a merge does NOT complete
    the task while its agent is mid-turn", "a reopened task stays running when its next
    idle turn is on an unmerged episode"): a present agent handed follow-up work may still
    be mid-turn, so only its own idleness on the merged episode may conclude it,
    reversibly. The reconciler owns everything after that. `failed`/`cancelled` are never
    gated on the session - the status was already concluded.
  - **Phase 1's retention rule had to widen, as that audit item predicted.**
    `preservesHistoricalMergeEvidence` kept merged bindings for
    `running`/`dispatching`/`done` only, so a `failed` task's merge evidence was deleted
    before it could be upgraded, and an UNMERGED historical URL was deleted before the
    harvest could ever poll it. It is now `preservesCompletionEvidence(task, merged)`:
    merged evidence survives every status but `backlog`, unmerged PR-carrying evidence
    survives exactly while `completableByMerge` holds.
  - **`completableByMerge` (exported from `registry.ts`) is the one status predicate**,
    shared by the harvest, the retention rule and the reconciler. Phase 3 must extend that,
    not restate the tuple.
  - **Final API shape.** `taskPrPollTargets()` returns
    `string[]`, not `{url, episodeTuple}`: the poller needs only what to ask about, and
    `reconcilePrMerges` re-reads the owning binding anyway - handing tuples out and back
    would be a second copy of the same lookup. `DependencyPrPollState` →
    `PrUrlPollState` and `reconcileDependencyPrMerges` → `reconcilePrMerges`, both now
    serving two harvests; the exit criterion (ONE cadence, one entry point) is met, and
    folding the reconcile was required rather than optional - it is not a pure write, so
    two passes would roll the same episode over twice in one tick.
  - **Two tests were reversed, deliberately**: `task-merge-settles.test.ts`'s "a cancelled
    task is left cancelled" (now the upgrade) and `task-dependencies.test.ts`'s "reset
    after delayed merge rollover..." tail, where the reset-cancelled prerequisite is now
    upgraded from its OWN merge - the case still pins that the replacement episode's merge
    is not attributed to it.
  - **A durable-candidate query remains a later-phase follow-up.** The Registry's bounded
    task map includes every active task and every terminal task still holding resources,
    but not a reclaimed `failed`/`cancelled` task once it has aged past
    `RECENT_TERMINAL_TASKS`. After a restart, a pull request that merges for that residue
    is not harvested until completion candidates are loaded independently of the recent
    history cap.
