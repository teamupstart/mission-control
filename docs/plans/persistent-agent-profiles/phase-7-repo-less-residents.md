# Phase 7: Residents without a repository

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

A resident can launch without choosing a repository. It runs in a Mission-owned working
directory created for the run and removed when the run ends, and every repository-shaped surface
(worktree provisioning, diffs, pull requests, retention, repository grouping) leaves it alone.

## Entry criteria and dependencies

- Phase 1 merged.

## Scope

- `repoAvailability: "optional"` in `TaskKindBehavior`, used only by `resident`.
- A repo-less launch path in `ResidentManager` and the dispatcher.
- A Mission-owned run workspace under the state home.
- Consumers that assume a Git checkout skip repo-less tasks through one shared predicate.

### Non-goals

Repo-less tasks of any other kind; changing the `tasks.repo_root NOT NULL` column.

## Repository findings and inherited contracts

- `tasks.repo_root` is `NOT NULL` (`src/server/db.ts`) and `DispatchSchema.repoRoot` is
  required. Every kind declares `repoAvailability: "workspace"` (`src/shared/task.ts`) except
  `pipeline`, which declares `"pipeline-enabled"`; neither allows a task without a repository.
  Worktree provisioning (`provisionAll` in `src/server/dispatcher.ts`), the retention observer
  and the cleanup queue all assume a Git checkout.
- `TaskRepoEntry` and task cards read `repoRoot` for grouping and links.
- Inherited: `ResidentManager.launch`, the workspace section from Phase 1, the run row.

## Implementation steps

1. **Shared predicate**: add `"optional"` to `repoAvailability`; set it for `resident`; add
   `taskHasRepository(task)` in `src/shared/task.ts` as the one test every consumer uses.
2. **Workspace**: a repo-less run gets `$MISSION_HOME/residents/runs/<runId>/workspace/`
   (created at launch, owned by the run). Record it on the run (`addColumn` `workspace_dir`),
   store it as the task's `repo_root`, and mark the task with a new nullable
   `tasks.workspace_kind` column (`addColumn`; null means a Git checkout, `resident-workspace`
   means this directory), projected onto `Task` as `workspaceKind`, so the column stays non-null
   without pretending to be a repository.
3. **Dispatch**: when the run has no repository, skip worktree provisioning and use the workspace
   as cwd; everything else follows the Phase 1 SDK path.
4. **Consumers**: route diff capture, pull-request surfaces, retention observation, cleanup
   return, repository grouping and repository links through `taskHasRepository`, so repo-less
   residents are excluded rather than observed as unreadable trees.
5. **Cleanup**: remove the workspace when the run ends, through the existing durable completion
   path and its startup twin.
6. **UI**: the Dispatch Resident tab and the profile's workspace section allow "No repository";
   cards show "no repository" instead of a repository group.
7. **Documentation**: `docs/residents.md` and the task lifecycle notes in
   `docs/worktrees-and-checks.md`.

## Tests and verification

- Unit: predicate coverage for every consumer touched, launch without repository, workspace
  creation and removal, retention and cleanup skip, upgrade from a Phase 1 database.
- Playwright `e2e/specs/residents-no-repo.spec.ts`: launch with "No repository", see the card
  without a repository group, complete and close.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## Exit criteria

Repo-less residents launch, run and clean up, and no repository-only code path touches their
workspace.

## Downstream handoff

`taskHasRepository` is the only test for whether a task has a repository; new consumers use it.

## Cross-phase audit record

- Concurrent with Phases 2 to 6; touches the workspace section and launch path only through
  Phase 1's documented seams.
- Pull request review (CodeRabbit): the finding about existing `repoAvailability` values now
  names `pipeline-enabled`.
