# Phase 2: Session-independent completion reconciler

## Outcome

Any task whose durable record shows a merged PR reaches `done` - without a live session,
without episode currency, and **upgrading `failed`/`cancelled` rows** (adopted decision 2).
Standalone tasks whose sessions are gone get their PRs polled by URL, so the merge is
observed at all. After this phase the user's headline requirement holds end-to-end: merged
work never blocks backlog scheduling, whatever state its session is in.

## Entry criteria and dependencies

- **Depends on Phase 1** (`phase-1-durable-merge-record.md`): `mergedPrFor` reads
  current + historical bindings, and `markWorkEpisodeMerged` stamps both tables. This
  phase's reconciler is a consumer of that contract and must not reimplement either half.
- Same merge-awareness note as Phase 1 regarding PR #224: base includes it.

## Scope

1. **By-URL polling for task-bound PRs (`src/server/registry.ts` + `src/server/pr.ts`).**
   Extend the URL harvest that feeds the existing by-URL poller (today only
   `dependencyPrPollTargets`) with a task-completion harvest: for every task in
   `running` / `dispatching` / `failed` / `cancelled`, collect `prUrl` from its current
   binding and `historicalTaskWorkEpisodeBindingsForTask` rows where `mergedAt === null`.
   Reuse `DependencyPrPollState`'s cadence machinery so a URL is polled at its existing
   rate - do not add a second cadence. A URL already merged in the record is never
   re-polled (its `mergedAt` is stamped; harvest excludes it).
2. **Route observed merges through the existing attribution.** When the by-URL lookup
   reports `merged`, call `reconcileWorkEpisodeMerge` with the **binding's own episode
   tuple** - exactly the shape `reconcileDependencyPrMerges` already uses for its
   candidates - so `markWorkEpisodeMerged` (Phase 1) stamps the durable record. Do not
   invent a parallel recording path.
3. **The completion reconciler (`src/server/tasks.ts`).** One method on `TaskManager`,
   e.g. `reconcileMergedTasks()`: for each task in `running` / `dispatching` / `failed` /
   `cancelled`, if `mergedPrFor(task.id)` returns a URL, move the task to `done`:
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
     `reconcileDependencyPrMerges` in `pollPrs`, or via a registry event the manager
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

- The by-URL poller and its cadence live in `src/server/pr.ts` (`DependencyPrPollState`,
  `queryPrUrl`) and are fed by `registry.dependencyPrPollTargets()`; merges flow to
  `registry.reconcileDependencyPrMerges(mergedUrls)` (pr.ts:236-292). This phase widens
  the harvest and the routing, not the mechanism.
- `blockersIn` (`@shared/backlog.ts`) treats `failed`/`cancelled` as a `stopped` blocker
  and clears only on `done` - the upgrade is what unblocks dependents.
- `agentIsFree` refuses a session with a `running`/`dispatching` task - completion is what
  frees the agent. No change needed there.
- `complete()` (tasks.ts:1461) keeps `sessionId` and resources; `cancel()` sets
  `cancelled`. Confirm what `cancel` does to `sessionId` and preserve display sanity on
  upgrade (Phase 3 owns the semantics; here just don't regress it).

## Implementation steps (execution order)

1. `src/server/registry.ts`: add the task-completion URL harvest (name it what it is,
   e.g. `taskPrPollTargets()`), returning `{url, episodeTuple}` entries; wire into
   `pollPrs` beside `dependencyPrPollTargets`, deduplicating URLs across the two.
2. `src/server/pr.ts`: route merged results for those URLs through
   `reconcileWorkEpisodeMerge` with the binding tuple (mirror
   `reconcileDependencyPrMerges`'s candidate loop; consider folding both into one
   registry entry point to avoid a second copy of the loop).
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
- No second by-URL cadence: one `DependencyPrPollState`-backed pipeline serves both
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
