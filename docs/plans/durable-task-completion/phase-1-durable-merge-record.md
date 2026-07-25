# Phase 1: Durable merge record and lookup

## Outcome

A merge observed for a task's PR is recorded durably on that task's work-episode binding -
**current or historical** - and every completion lookup reads the whole record. After this
phase, `agentWentAway` completes (rather than fails) a task whose PR merged on a
rolled-past episode, because `mergedPrFor` finally sees it. This is the foundation the
reconciler (Phase 2) and the multi-task formalization (Phase 3) read from.

## Entry criteria and dependencies

- **No phase prerequisites.** First phase.
- **Merge-aware entry criterion:** PR [#224](https://github.com/mancej/ai-harness/pull/224)
  (`mancej/complete-merged-sessions`, "complete merged tasks before closing idle sessions")
  edits `settleMergedTask` / `closeMergedSession` in `src/server/tasks.ts` and
  `test/task-merge-settles.test.ts`. **Start from a base that includes it** (rebase over it
  if it lands mid-flight). This phase does not modify the functions #224 reorders; it
  changes what `mergedPrFor` returns underneath them.

## Scope

1. **`bindTaskWorkEpisode` (`src/server/db.ts`) archives the outgoing PR binding.**
   Before rollover overwrites a task's current binding, copy a PR-carrying outgoing
   binding to `historical_task_work_episode_bindings` in the same transaction. Preserve
   an existing historical `mergedAt` if the same episode is archived again. Without this
   writer, the historical lookup below has no durable record to read.
2. **`markWorkEpisodeMerged` (`src/server/db.ts`) also stamps the historical binding.**
   Before this phase it updated `session_work_episodes` and
   `task_work_episode_bindings` by
   `(session_id, episode_id, pr_url)`. Add the same `COALESCE(merged_at, ?)` UPDATE over
   `historical_task_work_episode_bindings`, in the same transaction. A binding that rolled
   to historical before the merge was observed currently loses the fact forever.
   - `historical_task_work_episode_bindings` has no `merged_at` column check needed: verify
     with the schema; if the column is missing there, add it via `addColumn` in `migrate()`
     (NEVER in the CREATE block - see the `idx_tasks_schedule` precedent in CLAUDE.md), and
     remember the existing `addColumn(d, "task_work_episode_bindings", "merged_at", ...)`
     at `db.ts:1231` as the worked example.
3. **`mergedPrFor(taskId)` (`src/server/tasks.ts`) reads current + historical.**
   Pre-phase shape: read only `taskWorkEpisodeForTask(taskId)`. New shape: gather the
   current binding plus `historicalTaskWorkEpisodeBindingsForTask(taskId)`
   (`db.ts:2700`); return the `prUrl` of any row with `mergedAt !== null && prUrl`,
   preferring the **newest `mergedAt`** when several merged (a fix-forward task can produce
   more than one PR; the latest merge is the outcome to display).
4. **Recording reaches rolled episodes on the live-poller path.** In
   `reconcileWorkEpisodeMerge` (`src/server/registry.ts`), `markWorkEpisodeMerged` is
   already called unconditionally with the target episode tuple - keep that. The gap is
   upstream: the live poller (registry ~2568) only calls it when `acceptPrForEpisode`
   accepted the merged PR against the session's **current** episode. Do NOT loosen
   `acceptPrForEpisode` (it guards live-card attribution). Instead note explicitly in this
   phase that full coverage of the rolled/killed case arrives with Phase 2's by-URL
   harvest, which routes through `reconcileWorkEpisodeMerge` with the binding's own
   episode tuple - the same way `reconcilePrMerges` does. This phase
   makes those calls land durably; Phase 2 makes them happen for standalone tasks.

## Non-goals

- No reconciler, no new polling, no terminal-state upgrades (Phase 2).
- No change to `settleIfEpisodeFinished`'s episode-currency gate: its inference ("the
  agent is idle on the SAME episode that merged") is what keeps the reversible
  auto-complete honest for a live session, and #224 depends on it. `agentWentAway` is the
  path this phase corrects - the session is gone, so episode currency is meaningless there.
- No `Task.sessionId` semantics changes (Phase 3).
- No UI changes.

## Repository findings this phase rests on

- `TaskWorkEpisodeBinding` already carries `prUrl`, `prHeadSha`, `mergedAt` (db.ts:2321).
- `historicalTaskWorkEpisodeBindingsForTask` exists (db.ts:2700) - the read this needs.
  The historical table previously had readers but no rollover writer, so this phase must
  populate it before relying on it for completion.
- `agentWentAway` (tasks.ts:549) already calls `mergedPrFor` and completes on a hit; it
  needs no change beyond what `mergedPrFor` now returns.
- `deleteHistoricalTaskWorkEpisodeBinding` is called from `reconcilePrMerges`
  after a historical binding satisfies a dependency (registry.ts:2748). **Audit that
  deletion**: after this phase a historical binding is also completion evidence, so
  deleting it must not erase an unread merge. Preserve merged bindings while their task is
  `running`, `dispatching`, or provisionally `done`; failed/cancelled bindings and open
  historical PRs remain outside this phase.

## Implementation steps

1. `src/server/db.ts`: archive the outgoing PR-carrying binding during rollover, then
   extend `markWorkEpisodeMerged` with the historical-table UPDATE; add the migration
   `addColumn` if the column is absent; keep each write's single-transaction shape and the
   merge stamp's `changes > 0` return covering all three tables.
2. `src/server/tasks.ts`: rewrite `mergedPrFor` per scope item 3, with a doc comment
   stating the durable-record contract ("a merge on ANY of this task's episodes completes
   it - the session's current episode is irrelevant here").
3. `src/server/registry.ts`: audit the `deleteHistoricalTaskWorkEpisodeBinding` call per
   the finding above; adjust ordering or gating as chosen.
4. Tests (`test/task-merge-settles.test.ts` additions, or a new
   `test/task-durable-merge.test.ts` following the repo's `<feature>-<aspect>` naming,
   `HARNESS_HOME` preamble before imports):
   - a merge recorded via `markWorkEpisodeMerged` on an episode whose binding has rolled
     to historical is visible to `mergedPrFor`;
   - `agentWentAway` on a task whose merged PR sits on a historical episode completes the
     task with `merged <url>` (not `failed`);
   - several merged bindings → newest `mergedAt` wins;
   - existing `task-merge-settles.test.ts` and `task-session-orphan.test.ts` stay green.

## Data / migration notes

- New column (if needed) on `historical_task_work_episode_bindings`: `merged_at INTEGER`,
  added in `migrate()` via `addColumn`. No index needed.
- No wire-type changes; `TaskWorkEpisodeBinding` already models `mergedAt`.

## Verification

```sh
npm run typecheck && npm test && npm run build
```

## Merge / exit criteria

- All listed tests green on CI (Node 24 + 26).
- `mergedPrFor` provably reads historical bindings (test pins it).
- Rollover provably writes the outgoing PR-carrying binding to history (test pins it).
- No behavior change for a task whose episode never rolled (the ordinary case).

## Downstream handoff

Later phases may rely on:
- `mergedPrFor(taskId)` = "the newest merged PR across ALL of this task's bindings, or
  null" - **the** durable completion lookup. Phases 2-3 must not reimplement it.
- `markWorkEpisodeMerged` stamping current AND historical binding rows in one transaction.
Later phases must not change the binding tables' shape.

## Cross-phase audit record

- 2026-07-24: initial version. Coverage boundary with Phase 2 stated explicitly (this
  phase makes merge recording durable wherever `reconcileWorkEpisodeMerge` is invoked;
  Phase 2 extends WHO gets invoked for standalone tasks).
