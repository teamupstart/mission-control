# Phase 3: Multiple tasks per session, formalized

## Outcome

`Task.sessionId` means exactly "currently executing on" and nothing else; a session runs
tasks **serially** over its life, each task's provenance (episodes, PRs) living in its
bindings; a completed task frees its agent for the next assignment immediately; and every
reader of `Task.sessionId` / `Session.task` is audited against the retired
1:1-for-the-session's-life assumption. Documentation (README + CLAUDE.md architecture
notes) states the model.

## Entry criteria and dependencies

- **Depends on Phase 2** (`phase-2-completion-reconciler.md`): the reconciler is what
  makes "completed task frees its agent" true without human clicks; this phase's
  multi-task tests exercise that flow and its audit repoints readers at contracts
  Phases 1-2 established (`mergedPrFor`, `reconcileMergedTasks`).

## Scope

1. **State the semantics where they are enforced.**
   - `Task.sessionId` doc comment (in `@shared/types.ts` where `Task` is declared, and at
     `TaskManager.assign`/`dispatch`): a mutable "currently executing on" pointer,
     nullable; provenance questions go to the bindings, never to this field.
   - Serial-execution invariant stays: at most one `running`/`dispatching` task per
     session at any moment. `agentIsFree`'s "no non-terminal task bound" clause and
     `TaskManager.assign`'s server-side re-check are the enforcement - name the invariant
     in both places.
2. **Audit every reader for the 1:1 assumption.** Grounded list (extend it during
   implementation if grep finds more):
   - `Registry.activeTaskFor` (registry.ts ~3697): once a session accumulates several
     terminal task rows still carrying its id, the pick must be deterministic - prefer
     the non-terminal row; among terminal rows prefer the newest `updatedAt` (the card
     briefly shows the just-finished task's outcome, which is the current behavior for
     one task and the right generalization for N).
   - `reconcileTasksBoundTo` / `reconcileTasksWithNoLiveSession` (tasks.ts): iterate ALL
     rows carrying the session id (they already do); confirm ordering with Phase 2's
     reconciler (complete-by-merge wins before `agentWentAway` fails the rest).
   - `agentWentAway`: only non-terminal rows (already guarded); confirm it never clears
     `sessionId` on a row another live task legitimately shares - it nulls its own row
     only.
   - `reopenIfWorkResumed`: keyed on `autoCompleted.get(task.id) === s.id` - already
     per-task; confirm a session working on task B cannot reopen auto-completed task A
     (the map holds one entry per task, so it cannot; pin with a test).
   - Foreman `backlog-machine.ts` (`agentIsFree`, `activeAgentCount`): non-terminal
     filters already correct; add the N-tasks test.
   - The reset path (`src/server/reset.ts`) and Clean up (`reclaim`): confirm they key on
     the task row, not "the session's task".
   - The card (`taskSummaryFor` consumers: SessionCard, ConsoleDetail, SessionTile,
     RailRow - the four-surface rule): no component change expected once
     `activeTaskFor`'s pick is deterministic; verify all four surfaces render the
     CURRENT task after a second assignment (layout-parity rule from CLAUDE.md).
3. **Terminal rows release the pointer where that is what the reader needs.** Decide ONE
   rule and apply it consistently: keep `sessionId` on terminal rows (provenance-ish
   display convenience, current behavior for `done`) OR null it on completion the way
   `agentWentAway` nulls it on failure. Recommendation: **keep it**, and make every
   liveness-flavored reader filter on non-terminal status instead - fewer writes, no
   information destroyed, and `activeTaskFor`'s deterministic pick handles display.
   Record the decision in the `Task.sessionId` doc comment.
4. **Documentation.** README: the task lifecycle section gains the model in two
   sentences (serial tasks per session; completion follows the merged PR; close-on-merge
   is a separate preference). CLAUDE.md's "A session going away" block gets one line
   noting completion now reads durable bindings (keep it short; the architecture file
   lists surfaces that move together, not feature docs).

## Non-goals

- No concurrent tasks in one pane - serial stays the invariant.
- No schema changes (`Task.sessionId` column semantics change, not shape).
- No new completion path: everything routes through Phase 2's reconciler.
- No Foreman behavior changes beyond what the audit corrects.

## Repository findings this phase rests on

- `activeTaskFor` correlates ASSIGNED tasks by `sessionId` (stronger claim) and
  DISPATCHED ones by worktree path; it skips `backlog`/`cancelled` - the multi-task pick
  order generalizes exactly here.
- `agentWentAway` already nulls `sessionId` on the row it fails ("can never name a
  running agent again" - synthetic ids are pid-scoped), which is compatible with rule 3
  either way.
- `complete()` keeps `sessionId` today - the recommended rule 3 codifies that.

## Implementation steps (execution order)

1. `@shared/types.ts` + `TaskManager.assign`/`dispatch`: semantics doc comments; name the
   serial invariant at its two enforcement points.
2. `src/server/registry.ts`: deterministic `activeTaskFor` pick (non-terminal first,
   then newest terminal).
3. Audit pass over the reader list (scope 2), fixing anything that assumed 1:1-for-life;
   keep a short audit note per site in the PR description.
4. README + CLAUDE.md lines (scope 4).
5. Tests (new `test/task-multi-session.test.ts`):
   - session runs task A → A completes via merge (Phase 2 path) → `agentIsFree` passes →
     task B assigned to the SAME session → B's completion reads B's bindings, never A's;
   - `activeTaskFor` picks the non-terminal row when a terminal one still carries the id;
   - all four session surfaces (renderToStaticMarkup, per repo convention) show task B
     after the second assignment;
   - `reopenIfWorkResumed` cannot reopen A while B runs;
   - serial invariant: assigning B while A is `running` is refused server-side.

## Verification

```sh
npm run typecheck && npm test && npm run build
```

## Merge / exit criteria

- Multi-task tests green on CI; four-surface parity verified.
- README/CLAUDE.md updated in the same PR (repo rule: stale docs are a rejected change).
- The audit list in the PR description names every touched reader and its disposition.

## Downstream handoff

- `Task.sessionId` = "currently executing on"; provenance = bindings. Any future feature
  needing "which session produced this work" reads bindings.
- The serial invariant and its two enforcement points.
Nothing further depends on this phase inside this plan.

## Cross-phase audit record

- 2026-07-24: initial version, audited against Phases 1-2: consumes `mergedPrFor` and
  `reconcileMergedTasks` as the only completion machinery; its tests drive the Phase 2
  reconciler rather than a bespoke path; rule 3's recommendation (keep `sessionId` on
  terminal rows) matches `complete()`'s existing behavior so Phase 2 needs no change.
