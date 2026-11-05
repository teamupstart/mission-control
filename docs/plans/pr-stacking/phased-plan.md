# Stacked pull requests: phased implementation

Source plan: `docs/plans/pr-stacking/plan.md` (managed plan
`f5ebed25-67d1-4571-a75f-e14fde45d6c1`). This index and its phase files are the
implementation route. The source plan owns the goal.

## Adopted decisions (from the first review)

| Decision | Adopted |
|---|---|
| Stacking model | Dependency-based: Shipping default plus per-dependency override |
| When a stacked dependent may start | Prerequisite pull request open and its agent finished the episode |
| Restack after a parent squash-merges | Merge the new base into the child and push (no force-push) |
| Where the default applies | One switch for all repositories |
| Follow-up | Phased implementation plan (this document) |

## What the repository says

These findings change or sharpen the source plan. Revision 3 of the source plan already
reflects them.

| Finding | Where | Consequence |
|---|---|---|
| A dispatch already accepts a pinned full-SHA base, `TaskDispatchOptions.baseSha`, verified by `verifyPinnedBase`. Today only ensembles use it. There is no `fetchDefaultSha` on the dispatch path | `src/server/dispatcher.ts` (`resolveDispatchBase`, `resolveTaskBases`), `src/server/git/remote-default.ts` | A stacked dispatch pins the parent's head SHA through the existing option. No second base path |
| Native worktree leases are detached at the base commit. Only the git fallback creates a branch | `src/server/worktrees/git.ts`, `provisionWorktree` in `dispatcher.ts` | "Cut from the parent" means "detached at the parent head". The agent's own branch and PR base are what make it a stack |
| `declaredBlockersIn` is pure shared code and is the one predicate that dispatch, assign, the autopilot, the board, the Line and Sitrep read | `src/shared/backlog.ts`, `TaskManager.dependencyBlockers` in `src/server/tasks.ts` | Stack readiness is stamped on the edge by the daemon. The shared predicate reads the stamp, so every reader agrees without session state |
| An edge's `satisfiedAt` is written only by merge paths (`satisfyDeclaredEdgesTo`, `reconcileWorkEpisodeMerge`, plan publication) | `src/server/tasks.ts`, `src/server/registry.ts`, `src/server/plans/publication.ts` | Stacking adds separate fields. `satisfiedAt` and its merge rule are not touched |
| "Episode finished" for merged-task settling is `settleIfEpisodeFinished`: idle, empty queue, current episode, landed | `src/server/tasks.ts` | Stack readiness reuses the idle, empty-queue and current-episode parts, and swaps "landed" for "open, non-draft PR" |
| `mergeVerdict` lives in shared code with an ordered `MergeBlock` union and `MERGE_BLOCK_LABEL`. Unknown block strings render verbatim | `src/shared/shipping.ts`, `src/web/lib/pr-standing.ts` | The stacked-base gate is a new `MergeBlock` with a label |
| The Inspector `PR_QUERY` reads `headRefName` but not `baseRefName`, the repository default branch or `mergeStateStatus` | `src/server/inspector/github.ts` | Phase 1 adds base and default branch. Phase 2 adds `mergeStateStatus` |
| The PR prompt is `actions/pull-request.md` (generated into `builtin-session-actions.generated.ts` by `npm run session-actions`), deferring to `skills/pull-request/SKILL.md`. Ship tasks get `SHIP_COMPLETION_HANDOFF` from `withTaskKindContract` | `scripts/builtin-session-actions.ts`, `src/server/task-contract.ts` | The base instruction is added at runtime from the task's stack fields, never by hand-editing generated files |
| CodeRabbit follow-up prompts are sent by Foreman through `POST /api/sessions/:id/inject`, with `claimCodeRabbit` before delivery | `src/server/inspector/code-rabbit-delivery.ts`, `src/server/foreman/review-followup.ts`, `src/server/routes.ts` | Restack and catch-up prompts reuse this path (the source plan's "same delivery rules"). The daemon does not become a second unleased autonomous writer (`src/server/skills/reload.ts`) |
| `ShippingConfigSchema` changes must also land in `shippingFields` or the build fails. Backups pick new keys up automatically. The config route is `PUT /api/shipping/config` | `src/shared/app-config-entries.ts`, `src/server/settings-backups/config-registry.ts`, `src/server/routes.ts` | New keys are snapshot-covered for free |
| Dependency chips and the `+ Add dependency` picker live in `DispatchModal` for both dispatch and backlog edit. "after X" copy is `blockedLabel` | `src/web/components/DispatchModal.tsx`, `src/web/lib/backlog-copy.ts`, `BacklogColumn.tsx`, `line/BacklogDrawer.tsx` | One chip toggle serves both surfaces |
| The e2e fake `gh` handles `api graphql` (review threads only), `pr view` and `pr list`. It has no base fields, no `pr edit` and no PR PATCH | `e2e/fixtures/fake-agents.ts` | Each phase extends the fake for what its spec needs |

## Sizing

Estimated non-test production code: **1,100 to 1,500 lines**. Assumptions: about 200 shared
(schemas, eligibility, gate), 350 to 450 server (readiness stamping, pinned dispatch, PR
base check, snapshot fields, retarget, restack prompts), 300 to 400 web (Shipping card,
chip toggle, labels, merge-queue states), and 150 to 250 docs and the runtime prompt text.
The work is complex: a new edge state, a moving parent branch, GitHub base retargeting,
squash-merge restacking, and failure holds.

**Two phases.** A single task this size, with this many state transitions, is past what a
mid-tier model implements and explains reliably. There is a natural merge boundary that
lowers risk: Phase 1 lets a stacked child start and keeps it from being merged wrongly.
Phase 2 automates what happens when the parent moves, merges or breaks. After Phase 1 the
repository is operable. The setting ships off, and a stacked pull request that outlives
its parent is held by the merge gate with a visible reason, which a person can clear by
retargeting it on GitHub. Folding Phase 2 into Phase 1 would double the review surface
without adding anything that Phase 1 needs in order to be safe.

## Phases

| Phase | File | Delivers | Direct prerequisites |
|---|---|---|---|
| 1 | `phase-1-stacked-start.md` | Setting, per-edge mode, stack readiness, dispatch from the parent head, stacked PR base (instructed and corrected), stacked-base merge gate, base-aware review record, UI and docs | Planning session (this plan's merge) |
| 2 | `phase-2-stack-lifecycle.md` | Parent-moved catch-up prompts, retarget on parent merge, merge-based restack prompts, broken-stack holds and actions, lifecycle merge-queue states, docs | Phase 1 |

Dependency graph: planning session → Phase 1 → Phase 2. The phases are serial. Phase 2
consumes Phase 1's edge fields, task stack columns, snapshot base fields and merge gate,
so the two phases cannot run at the same time.

Merge order: Phase 1, then Phase 2.

## Cross-phase contracts

Phase 1 owns these names and Phase 2 must not rename them:

- `ShippingConfig.stacking: "merge" | "stack"` (default `"merge"`) and
  `ShippingConfig.maxStackDepth` (int 1 to 5, default 3).
- Task and session dependency edges gain an optional `mode: "merge" | "stack"`, absent
  meaning "inherit the Shipping default at evaluation time". They also gain a stack-readiness
  stamp: `stackReadyAt: number | null`, `stackBaseBranch: string | null`,
  `stackBaseSha: string | null`, `stackPrUrl: string | null`. All are optional on read, so
  stored rows parse unchanged.
- Shared pure functions in `src/shared/stacking.ts`: `effectiveEdgeMode(edge, config)` and
  `stackEligibility(task, tasks, config)`, returning either the single parent edge or a
  named reason for waiting for merge.
- Task columns `stack_parent_task_id`, `stack_base_branch`, `stack_base_sha`, `stack_pr_url`
  (exposed as `Task.stackParentTaskId`, `stackBaseBranch`, `stackBaseSha`, `stackPrUrl`),
  written once at dispatch.
- `PrSnapshot.baseRefName` and `PrSnapshot.defaultBranch`, plus `inspector_prs.base_ref_name`
  and the base recorded with the clean-review head.
- `MergeBlock` `"stacked-base"` with the label *Stacked on an unmerged pull request*.

## Final verification

After Phase 2 merges, an operator can turn stacking on, dispatch a two-phase plan, and
watch the second phase start from the first phase's open PR, open a PR based on it, and
land bottom-up under YOLO mode after a squash merge. Each phase's own tests, `npm run
typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and `npm run test:e2e` pass.
`docs/inspector-and-shipping.md` and `docs/dispatch-and-backlog.md` describe the shipped
behavior.

## Audit record

- Every source-plan requirement has exactly one owner. §1 eligibility, §2 release, §3
  cutting, §4 PR base, §7 gate, §8 base-aware review and the settings surface belong to
  Phase 1. §5 parent moved, §6 retarget and restack, and §9 broken stacks belong to
  Phase 2. Risks and non-goals bind both phases.
- §8 moved into Phase 1. GitHub can retarget a child by itself when a repository
  auto-deletes merged branches, and that can happen before Phase 2 exists. Recording the
  base with the reviewed head means any base change forces a new review from the first
  release.
- The source plan said "between YOLO mode and the CodeRabbit follow-up". The panel
  actually orders CodeRabbit before YOLO, so the card goes after the YOLO mode cards.
- The source plan put the stacked-base gate "first". It goes after the consent and
  `not-open`/`draft` gates, so an off switch or a closed PR still reads as the reason, and
  before every review and CI gate.
