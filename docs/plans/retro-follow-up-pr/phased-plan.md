# Phased implementation: post-merge retro follow-up pull requests

Source plan: [`plan.md`](plan.md) ([rendered](plan.html))

## Incorporated human decisions

| Decision | Adopted answer | Owner |
| --- | --- | --- |
| Does every retro get its own pull request? | No. An open work pull request keeps the retro on the existing branch and review. | Phase 1 |
| What happens after the work pull request merges? | Create or reuse a separately tracked retro task, dispatch it immediately when possible, and let approved changes open a new pull request. | Phase 1 |
| Does `Run retro` complete the source task? | No. The source task remains in its existing completed state. | Phase 1 |
| How does the retro task complete? | Its own pull request merge, or an explicit verified no-change outcome when no memory is approved. | Phase 1 |
| What if immediate launch is unavailable? | Keep the same idempotent task in the backlog and report why it is queued. | Phase 1 |
| What implementation task configuration should be scheduled? | Codex, `gpt-5.6-sol`, `xhigh`. | Scheduling |

## Repository findings that changed or sharpened the route

- `src/server/retro.ts` currently chooses only between live delivery and a dead-session
  backlog fallback. A merged pull request on a still-live session therefore takes the live
  branch and can reopen the already-completed source task.
- `src/server/db.ts` already exposes `primaryRepoPrForTask(taskId)`, but its merged-first rule
  serves completion and card projection, not retro routing. A task can have a historical merge
  and a current open pull request. The retro therefore needs a sibling durable query whose
  current open episode wins, with newest historical/current merged evidence used only when no
  current open pull request exists. `Session.prUrl` remains too weak because it is a projection
  that may lag branch or merge changes.
- `src/server/tasks.ts` deliberately lets new work reverse a completion inferred from idleness.
  A fresh linked task avoids treating the retro as resumed feature work and prevents the old
  merge from proving the new work complete.
- Durable merge tests already show why episode ownership matters: a historical merged binding
  can settle a reopened task after its session disappears. The retro task must have its own
  episode and pull-request bindings.
- The dead-session task intent already says a memory commit ships as ordinary task work, but
  the current retro skill also says a session action must stay on its current branch and never
  open another pull request. The skill and action need an explicit open-versus-merged branch.
- `RetroResponse` documents that new arms may be appended while existing arm names are frozen.
  All three dashboard callers currently reduce the result to delivered versus dispatched, so
  one shared formatter should own the expanded vocabulary.
- `CreateTaskInput` already carries the full repository set and launch provisioning fields.
  Task creation and dispatch should remain in TaskManager so worktree, dependency, SSE, and
  failure-recovery contracts are reused.
- Mission Control currently has no narrow, agent-callable success signal for a retro that
  correctly produces no commit. A new MCP operation must be validated in both shared protocol
  and bundled MCP server, added to `MISSION_MCP_TOOLS`, and covered by build plus smoke.
- UI behavior changes require a Playwright spec. `e2e/specs/retro-offer.spec.ts` already drives
  the real click, route, session delivery, and fake pull-request hook without spending model
  tokens, making it the correct regression surface to extend.

## Estimate and phase cut

Estimated gross non-test implementation size: **400 to 600 lines** across durable storage,
task orchestration, the retro route and intent, one narrow MCP outcome, response handling, and
dashboard copy. Test and documentation lines are excluded.

This remains **one phase** despite exceeding the 200-line guideline. The storage relation,
post-merge task creation, launch result, no-change settlement, response union, and visible
message form one transactional vertical slice. Splitting them would either expose a button
that creates work the UI cannot explain, create tasks that cannot finish without a fake pull
request, or publish a completion operation no launched retro can use. There is no safe,
reviewable intermediate product state worth merging.

## Phase

| # | Phase | File | Direct prerequisites |
| --- | --- | --- | --- |
| 1 | Post-merge retro follow-up lifecycle | [`phase-1-post-merge-retro-follow-up.md`](phase-1-post-merge-retro-follow-up.md) | Planning pull request merged |

### Dependency graph

```mermaid
flowchart LR
  PLAN[Planning pull request merged] --> P1[Phase 1: post-merge retro follow-up lifecycle]
```

Only one implementation task is scheduled. It depends on this planning session so Mission
Control keeps it backlogged until the planning pull request merges.

## Contracts owned by Phase 1

| Contract | Required shape |
| --- | --- |
| Pull request split | Open source pull request uses the current session; merged source pull request uses a linked task and new branch. |
| Source completion | Creating or running the retro follow-up never mutates the source task status. |
| Idempotency | At most one retro follow-up per source task work episode; repeated clicks reuse it. |
| Dispatch | Attempt immediate ordinary dispatch; on recoverable failure preserve the same visible backlog task. |
| Shipping | Approved memory commits in a follow-up task use ordinary pull-request shipping; no daemon git writes. |
| No-change completion | A narrow MCP operation can complete only the calling task when it is durably linked as a retro follow-up. |
| Response compatibility | Preserve `delivered` and `dispatched`; append `started` and `queued`. |
| Multi-repository work | Copy the source task's repository set and require one pull request per repository changed. |

## Final verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

The focused Playwright run may be used while iterating, but the final UI change must pass the
full end-to-end suite after a fresh build. Chromium installation is a machine prerequisite,
not a repository change.

## Cross-phase audit record

- **After drafting Phase 1:** verified that every approved decision is owned by the only phase,
  including the open-pull-request exception, source-task immutability, immediate dispatch with
  backlog fallback, automatic new pull-request shipping, and no-change completion.
- **Compatibility pass:** verified that the phase appends wire response arms, leaves existing
  task and session status vocabularies untouched, routes database writes through the daemon,
  and uses work-episode identity rather than a task-title convention.
- **Inspector reconciliation:** corrected the posture contract after repository review proved
  `primaryRepoPrForTask` intentionally lets any merged episode outrank a current open one. The
  phase now owns a separate current-open-first query and leaves completion semantics unchanged.
- **Mergeability pass:** verified that Phase 1 starts from the default branch after the planning
  pull request merges and ends with a complete user-visible lifecycle. No later phase is needed
  to repair an intermediate state.
- **Testing pass:** verified that backend, migration, task-lifecycle, MCP bundle, shared UI, and
  browser coverage all live in Phase 1, with no verification deferred.
