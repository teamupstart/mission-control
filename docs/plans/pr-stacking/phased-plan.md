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

Estimated non-test production code: **1,300 to 1,750 lines**. Assumptions: about 250 shared
(schemas, eligibility, gates, release check), 350 to 450 server (readiness stamping, pinned dispatch, PR
base check, snapshot fields, retarget, restack prompts), 300 to 400 web (Shipping card,
chip toggle, labels, merge-queue states), and 150 to 250 docs and the runtime prompt text.
The work is complex: a new edge state, a moving parent branch, GitHub base retargeting,
squash-merge restacking, and failure holds.

**Two phases.** A single task this size, with this many state transitions, is past what a
mid-tier model implements and explains reliably. There is a natural merge boundary that
lowers risk: Phase 1 lets a stacked child start and keeps it from being merged wrongly.
Phase 2 automates what happens when the parent moves, merges or breaks. After Phase 1 the
repository is operable. The setting ships off. A stacked pull request that outlives its
parent is held by the lineage-based `stack-hold` gate with a visible reason, even after
GitHub retargets it automatically. The release check also defines how a person clears it
by hand: merge the default branch into the child, or move its commits onto a fresh
branch. Folding Phase 2 into Phase 1 would double the review surface
without adding anything that Phase 1 needs in order to be safe.

## Phases

| Phase | File | Delivers | Direct prerequisites |
|---|---|---|---|
| 1 | `phase-1-stacked-start.md` | Setting, per-edge mode, stack readiness, dispatch from the parent head, stacked PR base (instructed and corrected), `stacked-base` and lineage-based `stack-hold` gates with the ancestry release check, base-aware review record, UI and docs | Planning session (this plan's merge) |
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
- `PrSnapshot.baseRefName`, `PrSnapshot.defaultBranch` and `PrSnapshot.mergeCommitSha`,
  plus `inspector_prs.base_ref_name` and the base recorded with the clean-review head.
- Stack lineage on the PR row:
  - `inspector_prs.stack_parent_pr_url`: the **current** parent. Phase 1 sets it from the
    task at adoption. The Shipping setting and the edge mode never change or clear it.
    Only Phase 2's replacement-parent transition may change it.
  - `inspector_prs.stack_base_sha`: the parent commit the child was cut at, copied from
    `Task.stackBaseSha` at adoption and never changed.
  - `inspector_prs.stack_released_head_sha`: the child head for which the release check
    passed. Null or a different head means held.
  - `inspector_prs.stack_task_id`: the stacked task the PR belongs to. Together with the
    row's repository (`owner`/`repo`), it lets later child PRs of the same task in the
    same repository find the previous row.
  - `inspector_prs.stack_lineage_history`: nullable JSON of `{from, to, at}` entries.
    Phase 1 creates the column and copies it on inheritance. Only Phase 2's
    replacement-parent transition appends to it.
- Primary-repository scope (Phase 1): stacking, readiness stamping, the dispatch pin, the
  `Task.stack*` fields and PR-row lineage cover the task's primary repository only.
  Readiness is stamped only from the prerequisite episode's open, non-draft PR in that
  primary repository. Secondary repositories
  start from their default branch, and their PRs get no lineage.
- Lineage seeding and inheritance (Phase 1): the task's dispatch-time fields seed only
  the task's first child PR row in its primary repository. Every later child PR of the
  same task in the same repository (for example a *Move onto main* or *Reopen against
  main* replacement) copies the latest previous row's `stack_parent_pr_url`,
  `stack_base_sha` and `stack_lineage_history` unchanged. The lookup key is
  `stack_task_id` plus the repository.
- Expected base (Phase 1): one function serves both the PR-opening instruction and base
  correction. It returns the current parent's head branch while that parent is open, and
  the default branch once it has merged or closed.
- Base correction (Phase 1): uses the expected base, and nothing is ever retargeted to a
  merged or closed parent's branch.
- The pure release check `stackReleased(facts)` in `src/shared/stacking.ts`, evaluated
  against the current parent, with the two branches stated in the source plan §7. A
  merged parent needs its merge commit in the child's ancestry. A closed parent needs
  neither `stack_base_sha` nor the parent's last head in the child's ancestry. The
  server-side compare helper supplies the ancestry facts, and unknown facts mean held.
- Review diff base (Phase 1): for a stacked task, the workflow Persona diff and the
  CodeRabbit merge base use the PR's current base, or the parent branch before a PR
  exists. Every other task keeps the default-branch diff.
- Replacement-parent transition (Phase 2): the only writer of a changed
  `stack_parent_pr_url`. It appends each change to `inspector_prs.stack_lineage_history`
  and never touches `stack_base_sha`.
- `MergeBlock` `"stacked-base"` (base is not the default branch) and `"stack-hold"`
  (lineage present and not released for the current head). These are the only two
  stacking gates, and they are owned by Phase 1.
- Scope rule: the Shipping default and edge `mode` decide only whether a dependent
  *starts* early. Recorded lineage, the hold and every lifecycle behavior apply to
  already-stacked pull requests whatever the setting says.

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
- Repair round 1 (Plan Validation run `423925d9-c8a3-4ef4-be1a-0a73aaeadd5b`):
  - A gate keyed only on "base is not the default branch" released a child as soon as
    GitHub or the daemon retargeted it, before any restack. Phase 1 now also owns a
    lineage-based `stack-hold` gate, the PR-row lineage, and the ancestry release check.
    Phase 2 consumes them and adds no gate of its own.
  - Phase 2's `unstacked` ("any new head since the retarget") was replaced by `released`,
    which means the release check passed for the current head. A changed head that does
    not contain the parent's merge commit stays held.
  - "With stacking off, nothing in this phase runs" contradicted the source plan's
    "already-started children stay stacked". The scope rule above now governs both
    phases.
- Repair round 2 (same run):
  - The closed-parent branch now also requires the recorded `stack_base_sha` to be absent
    from the child's ancestry. Before, a parent that pushed before closing could release
    a child that still carried its earlier commits. Phase 1 retains `stack_base_sha` on
    the PR row.
  - The lineage is now a current parent plus a history. Phase 2's replacement-parent
    transition is the only way it changes, and the release check reads the current
    parent, so waiting for a replacement ends in a defined release.
  - The manual release actions are stated per parent state and match the release check.
  - The base-relative Persona diff now has an owner, Phase 1 step 9, with tests.
- Repair round 3 (same run):
  - Before, a *Move onto main* replacement child was seeded from the task's dispatch-time
    fields. That could restore a parent that a replacement-parent transition had already
    swapped out. Now only the first child PR is seeded from the task, and later child PRs
    inherit the previous row's lineage. Phase 1 adds `stack_task_id` and owns the
    `stack_lineage_history` column.
  - Base correction compared against the task's original `stackBaseBranch`, so it would
    have retargeted that replacement onto the closed parent's (possibly deleted) branch.
    It now uses the current parent's state: the parent's branch while it is open, and the
    default branch otherwise.
- Repair round 4 (same run):
  - The PR-opening instruction named the dispatch-time parent branch. It now uses the
    same expected-base function as base correction, so a replacement child is told to
    target the default branch.
  - Phase 2's sequence test now expects the single history entry that its sequence
    actually defines.
  - A child PR that GitHub closed after a base deletion now has a defined recovery: a new
    child PR that inherits the lineage. It is *Reopen against main* when the parent
    merged, and *Move onto main* when the parent closed. *Wait for a replacement* now
    requires an open child PR.
  - The plan promised per-repository stacking that one task-level pin and lineage key
    could not support. Stacking is now scoped to the primary repository, matching
    `resolveTaskBases`, which pins only the primary repository. Lineage lookup is keyed
    by task plus repository.
- Repair round 5 (same run):
  - Readiness stamping now selects the prerequisite's PR in the shared primary
    repository. A secondary-repository PR can neither supply the stack base nor release
    the dependent (Phase 1 step 4, with a test).
  - The root plan's session-header base display had no owner. It was removed; the
    backlog card and Line row already show *Stacked on #N*.
  - The *Resume* recovery for a child with no session is now defined in Phase 2 step 4,
    with a test: the pending prompt is delivered to the resumed session on its first
    idle tick.
