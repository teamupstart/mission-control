# Phase 1: Stacked start

Source plan: `docs/plans/pr-stacking/plan.md`. Index: `docs/plans/pr-stacking/phased-plan.md`.
This file is the proposed route, not a specification. Where the repository disagrees,
follow the repository and record the deviation in the pull request.

## 1. Outcome

With **Settings → Shipping → Stacked pull requests** set to *Stack on its branch*, or with
a dependency chip set to **Stack**, a task whose single unmerged same-repository
prerequisite has an open pull request and an idle agent starts at once. It does not wait
for the merge. It is cut at the prerequisite's head, and it opens its pull request against
the prerequisite's branch. YOLO mode never merges a pull request whose base is not the
default branch, and a review against one base never authorizes a merge against another.
A PR with stack lineage stays held until a verified ancestry check shows it was
restacked, or moved off a closed parent. That hold holds even when GitHub retargets the
PR by itself. The setting ships off, so nothing changes for anyone who leaves it alone.

## 2. Entry criteria

- The planning session's pull request has merged, so these files resolve on `main`.
- No phase dependencies.

## 3. Scope and non-goals

In scope: the settings, edge mode, eligibility, readiness stamping, pinned dispatch, the
stacked PR base (runtime instruction plus daemon correction), snapshot base fields, the
`stacked-base` gate, the PR-row stack lineage, the `stack-hold` gate and its ancestry
release check, the base-aware clean-review record, the Shipping card, the chip toggle,
*Stacked on #N* labels, and docs for all of it.

Not in scope (Phase 2): catch-up prompts when the parent moves, retarget after the parent
merges, restack prompts, broken-stack holds and actions, and `mergeStateStatus`. Never in
scope: force-pushing, any daemon git operation that changes a worktree's checkout,
branches or commits, and cross-repository stacking. Read-only diffs and remote-tracking
fetches at the repository root, which the daemon already performs, are allowed.

## 4. Repository findings this phase relies on

See the index's findings table. In particular: `TaskDispatchOptions.baseSha` and
`verifyPinnedBase` (`src/server/dispatcher.ts`), `declaredBlockersIn`
(`src/shared/backlog.ts`), `settleIfEpisodeFinished` (`src/server/tasks.ts`), `mergeVerdict`
(`src/shared/shipping.ts`), `PR_QUERY` and `PrSnapshot` (`src/server/inspector/github.ts`),
`onPrOpened` adoption (`src/server/inspector/worker.ts`), `shippingFields`
(`src/shared/app-config-entries.ts`), and `DispatchModal` dependency chips.

## 5. Implementation steps

1. **Contracts** (`src/shared/protocol.ts`, `src/shared/types.ts`,
   `src/shared/app-config-entries.ts`). Add `stacking` and `maxStackDepth` to
   `ShippingConfigSchema` and `shippingFields`. Add optional `mode` to the task and session
   variants of `TaskDependencyInputSchema` and `TaskDependency`. Add the four optional
   stack-readiness fields to `TaskDependency`. Plan edges never stack.
2. **Eligibility** (new `src/shared/stacking.ts`). `effectiveEdgeMode` returns the edge's
   `mode`, or the config default when it is absent. `stackEligibility` applies source plan
   §1:
   - the edge is in stack mode;
   - the prerequisite's and the dependent's primary repositories are the same, because
     `resolveTaskBases` applies the `baseSha` pin to the primary repository only;
   - every repository the prerequisite changed other than that shared primary has
     already merged;
   - exactly one unmerged same-repository prerequisite remains;
   - every cross-repository prerequisite is satisfied;
   - the parent's own stack depth is below `maxStackDepth`.

   It returns `{ ok: true, edge }` or `{ ok: false, reason }` with a short reason the board
   can show.
3. **Shared blocker read** (`src/shared/backlog.ts`). In `declaredBlockersIn`, an edge that
   `stackEligibility` selects, and that has a recorded `stackReadyAt` timestamp, does not
   block *starting*. Treat both `null` and an absent field as unstamped (default the field
   to `null` when parsing stored edges), so an edge written before this phase can never
   unblock a dependent. Its `satisfiedAt` stays null. Leave `dependencyState` and inferred plan
   edges unchanged. Add a `stacked` flag to the readiness result if the board needs it, not
   a new `BlockerState`, so every exhaustive switch keeps compiling.
4. **Readiness stamping** (`src/server/tasks.ts`, next to `satisfyDeclaredEdgesTo`). When
   a prerequisite's session goes idle with an empty queue on its current episode, select
   that episode's PR in the prerequisite's **primary** repository: match the PR's
   owner/repo against the primary repository, and ignore PRs in secondary repositories. If
   that PR is open and not a draft, write `stackReadyAt`, `stackBaseBranch`
   (the PR head ref), `stackBaseSha` and `stackPrUrl` on every dependent edge whose
   effective mode is stack. Reuse the idle, queue and episode checks from
   `settleIfEpisodeFinished`. Clear the stamp on edges whose dependent has not started yet
   if the prerequisite leaves that state (a new turn, a draft, a closed PR). Persist
   through the existing `tasks.dependencies` JSON write. Emit the normal task upsert so the
   UI updates.
5. **Pinned dispatch** (`TaskManager.dispatch`, `src/server/dispatcher.ts`). When the
   dependent is stack-released, first revalidate the stamp, because it can go stale
   between being written and being cleared. Read the parent PR fresh. It must still be
   open and not a draft, and it must still be the stamped `stackPrUrl` on the
   prerequisite's current episode, with the stamped `stackBaseBranch` as its head branch.
   If any of these no longer holds, refuse the dispatch with the reason, clear the stamp
   in the same step, and leave the edge waiting. Only then fetch the parent branch from origin, read its current head
   SHA (newer than the stamp if the parent pushed since), and pass it as `baseSha`. The
   pin and the `stack_*` columns cover the primary repository only. Secondary
   repositories keep `resolveDispatchBase` and the default branch. On
   success, persist `stack_parent_task_id`, `stack_base_branch`, `stack_base_sha` and
   `stack_pr_url` (`addColumn` in the `tasks` upgrade path in `src/server/db.ts`, beside
   `base_sha`). If the fetch or the pin fails, refuse the dispatch with the reason. Never
   fall back to `main` silently. Manual dispatch, assign, drag-to-assign and the autopilot
   all reach this through `dependencyBlockers`. Check each one.
6. **Stacked PR base**. Add one shared function, `expectedStackBase`, that returns the
   current parent's head branch while that parent is open, and the default branch once
   it has merged or closed. The current parent is the latest lineage row for this task
   and repository when one exists, otherwise `Task.stackPrUrl`. In `withTaskKindContract`
   (`src/server/task-contract.ts`), and in the runtime PR packet where the workflow's
   pull-request action is sent, append for a stacked task's primary repository: *open
   the pull request with `--base <expectedStackBase>` and start the description with
   "Stacked on <current parent>".* Compute it when the text is sent, never once at
   dispatch. Change the source text through
   `actions/pull-request.md` and `npm run session-actions` only if a static line is
   needed. Never edit the generated file. Then enforce it. When the Inspector adopts a PR
   for a stacked task's session (after step 7 has set its lineage), compute the expected
   base with the same `expectedStackBase`, from the row's current parent, not from the
   task. If `baseRefName` differs, retarget the PR through the GitHub REST API (`PATCH
   repos/{owner}/{repo}/pulls/{n}` with `base`, the same `gh api` style as `mergePr`) and
   record a one-line note on the PR row. Never retarget to a merged or closed parent's
   branch. A replacement child opened against the default branch after its parent closed
   therefore keeps that base.
7. **Snapshot base fields and lineage** (`src/server/inspector/github.ts`,
   `src/server/db.ts`, `InspectorPr`).
   - Add `baseRefName`, `mergeCommit { oid }` and `repository { defaultBranchRef { name } }`
     to `PR_QUERY`. Expose them as `PrSnapshot.baseRefName`, `mergeCommitSha` and
     `defaultBranch`. Persist `inspector_prs.base_ref_name`.
   - Record the base next to the clean-review head (`cleanReviewHeadSha`), so a base that
     changes under the same head counts as not reviewed.
   - Add `inspector_prs.stack_task_id`, `stack_parent_pr_url` (the current parent),
     `stack_base_sha` and `stack_lineage_history` (nullable JSON).
   - When a PR is adopted for a session whose task has `stackParentTaskId`, and the PR is
     in the task's primary repository (PRs in secondary repositories get no lineage):
     - if an earlier row with the same `stack_task_id` and the same repository exists (the task's previous child
       PR, for example one replaced through *Move onto main*), copy the latest such row's
       `stack_parent_pr_url`, `stack_base_sha` and `stack_lineage_history` unchanged;
     - otherwise seed from the task: `stack_parent_pr_url = Task.stackPrUrl`,
       `stack_base_sha = Task.stackBaseSha`, with an empty history.

     Set `stack_task_id` either way. The Shipping setting and the edge mode never change
     or clear these values, and `stack_base_sha` never changes. The current parent may
     change only through Phase 2's replacement-parent transition, so Phase 1 adds no other
     writer.
   - Add `inspector_prs.stack_released_head_sha`, null on adoption.
8. **Release check** (`src/shared/stacking.ts`, `src/server/inspector/`). Add the pure
   `stackReleased(facts)` with exactly the two branches in source plan §7, evaluated
   against the row's current parent:
   - parent merged: the base is the default branch and the parent merge commit is an
     ancestor of the child head;
   - parent closed unmerged: the base is the default branch, and neither
     `stack_base_sha` nor the parent's last observed head is an ancestor of the child
     head.

   Any unknown fact returns held. On each Inspector tick, for a row with lineage and no
   release for its current head, read the current parent row's state, merge commit and
   last head.
   Ask GitHub's compare API (`gh api repos/{o}/{r}/compare/{ancestor}...{head}`; `ahead`
   or `identical` means it is an ancestor). On a pass, write
   `stack_released_head_sha = <current head>`. Never run git in a worktree for this.
9. **Review diff base** (`src/server/workflows/context.ts`, `src/server/diff.ts`). The
   workflow context builds the Persona diff with `computeSessionDiff(cwd)`, which diffs
   against the default branch. For a session whose task has `stackParentTaskId`, pass an
   explicit source instead:
   - the adopted PR's current `base_ref_name` when a PR row exists;
   - otherwise `stackBaseBranch`.

   Before every diff, refresh that branch. Fetch
   `+refs/heads/<base>:refs/remotes/origin/<base>` at the repository root, the same kind
   of remote-tracking fetch `fetchOrigin` in `src/server/git/remote-default.ts` already
   does, without touching the worktree's checkout. Then read the remote tip with
   `git ls-remote origin refs/heads/<base>`, check that the fetched ref equals it, and pass
   that verified SHA as the explicit source. If the fetch fails, the remote branch is
   gone, or the two disagree, the diff fails with a named reason (*stacked base could not
   be refreshed*) instead of using a stale ref.

   Apply the same base to the CodeRabbit command's pinned `mergeBase` (the merge base of
   the head and that ref). An explicit source gets no silent fallback in
   `computeSessionDiff`, so a missing parent ref fails visibly. Non-stacked tasks are
   unchanged.
10. **Merge gates** (`src/shared/shipping.ts`, `src/server/shipping/merge.ts`). Add
   `baseRefName`, `defaultBranch` and `stack: { lineage: boolean; releasedForHead: boolean }`
   to `MergeInput.pr`. Add two `MergeBlock`s, each with a `MERGE_BLOCK_LABEL`, evaluated
   in this order after `draft` and before the workflow and review gates:
   - `"stacked-base"`: only for a PR with stack lineage (`stack_parent_pr_url` set). The
     base is not the default branch, or either value is unknown (fail closed). A PR
     without lineage is never evaluated by this gate, so its merge behavior is exactly
     what it was before this phase;
   - `"stack-hold"`: lineage is present and `stack_released_head_sha` does not equal the
     current head.

   Pass both from `maybeMerge`. Make `not-reviewed` cover a reviewed base that differs
   from the current base.
11. **UI** (`ShippingSettingsPanel.tsx`, `DispatchModal.tsx`, `backlog-copy.ts`,
   `BacklogColumn.tsx`, `line/BacklogDrawer.tsx`).
   - A **Stacked pull requests** `ConsoleCard` after the YOLO mode cards. It holds the
     *Wait for merge* / *Stack on its branch* segmented control, the maximum-depth
     `NumberSetting`, and copy stating it never merges into a non-default branch, never
     force-pushes and never stacks across repositories. It also says that switching it
     off stops new stacks only: pull requests that are already stacked keep their hold.
     It saves through
     `PUT /api/shipping/config`. Register it in settings search and the settings dots like
     its siblings.
   - On each same-repository task or session dependency chip, a **Stack** / **After merge**
     toggle that shows the inherited default until it is changed. Draft mapping goes
     through `task-draft.ts` and `dependencyInputOf`.
   - *Stacked on #N* on the backlog card and Line row of a stacked task, and the
     eligibility reason in place of the plain "after X" when an edge in stack mode still
     waits.
   - The merge queue shows both new block labels.
12. **Docs**. `docs/inspector-and-shipping.md`: a new *Stacked pull requests* section,
    both gate rows, the release check with the manual action for each parent state
    (source plan §7 table), the base-aware review rule and the base-relative Persona
    diff. `docs/dispatch-and-backlog.md`: edge
    modes and stack release. `docs/configuration.md`: the two keys.

## 6. Data and compatibility

- New config keys come with Zod defaults, so stored blobs gain them on read.
- New edge fields are optional, so stored `tasks.dependencies` JSON parses unchanged, and an
  absent `mode` means "inherit".
- New `tasks` and `inspector_prs` columns are added through `addColumn` in the upgrade path,
  nullable. Existing rows mean "not stacked". A null `stack_parent_pr_url` means no
  lineage, so `stack-hold` never touches pre-existing PRs.
- A PR row reviewed before this phase has no recorded base. Treat that as matching only when
  the current base is the default branch, so existing default-branch PRs are not forced into
  re-review.
- Settings backups pick the keys up through `SETTINGS_CONFIG_BACKUP_ENTRIES`. Confirm with
  the backup round-trip test.

## 7. Tests and verification

- `test/`:
  - `stackEligibility` table: same repository, cross repository, two unmerged
    prerequisites, depth cap, a multi-repository task, plan edges excluded.
  - `declaredBlockersIn` with stamped and unstamped stack edges, where unstamped covers
    both `stackReadyAt: null` and an edge with no `stackReadyAt` field at all.
  - Stamping and clearing transitions.
  - A prerequisite with PRs in its primary and a secondary repository stamps the
    primary-repository PR's branch, SHA and URL. A prerequisite whose only open PR is in a
    secondary repository stamps nothing and does not release the dependent.
  - Pinned dispatch, plus refusal when the fetch fails.
  - Dispatch revalidation: a stamp written while the parent was open, followed by the
    parent becoming a draft, closing, or moving to a new episode or branch before the
    stamp is cleared, refuses the dispatch, clears the stamp, and leaves the edge
    waiting.
  - Base correction on adoption:
    - a PR opened against the wrong base while its parent is open is retargeted to the
      parent's branch;
    - a replacement child opened against the default branch after its current parent
      closed is left on the default branch and never retargeted to the closed parent's
      branch;
    - nothing is retargeted to a merged parent's branch.
  - PR-opening instruction:
    - the first child is told the open parent's branch;
    - a replacement child after its current parent closed or merged is told the default
      branch, not the dispatch-time `stackBaseBranch`.
  - Primary-repository scope:
    - a multi-repository dependent whose prerequisite has an unmerged change only in a
      secondary repository waits for merge;
    - the pin applies to the primary repository only;
    - a stacked task's secondary-repository PR gets no lineage.
  - Lineage inheritance:
    - the first child PR of a task is seeded from the task;
    - the lookup ignores rows of the same task in a different repository;
    - a second child PR of the same task copies the latest previous row's current
      parent, stack base and history, even when the task's `stackPrUrl` names a
      different (earlier) parent.
  - `mergeVerdict` refusing a non-default base and an unknown base for a PR with lineage,
    and leaving a PR without lineage unaffected by both stacking gates, even when its
    base or default branch is unknown or is not the default branch.
  - `stack-hold`:
    - still holds after the base changes to the default branch with an unchanged head
      (an automatic retarget);
    - still holds after a new head that does not contain the parent's merge commit
      (an unrelated push);
    - releases only when the compare call shows ancestry;
    - re-checks after a later head;
    - holds on a compare failure;
    - releases on the closed-parent branch once the child contains neither
      `stack_base_sha` nor the parent's last head;
    - still holds when the parent pushed again before closing: the last head is absent
      but `stack_base_sha` is present;
    - still holds after the default branch is merged into a child whose parent closed
      unmerged;
    - releases after the default branch is merged into a child whose parent merged;
    - reads the current parent, so a changed `stack_parent_pr_url` is evaluated against
      the new parent;
    - still holds with the setting switched off.
  - Lineage (`stack_parent_pr_url`, `stack_base_sha`) copied at adoption and never
    changed by the setting or the edge mode.
  - Workflow context diff for a stacked task is computed against the PR's current base,
    or the parent branch before a PR exists, and the CodeRabbit merge base matches it.
    A non-stacked task's diff is unchanged.
  - Stale base: in a fixture, the parent branch gains a commit on the remote after the
    child's dispatch while the local `origin/<base>` is still old. The next review diff
    refreshes it and diffs against the new parent tip. A failed fetch, a deleted remote
    branch, and a fetched ref that disagrees with `ls-remote` each fail the diff visibly,
    and never fall back to the stale ref.
  - Review invalidation on a base change.
  - Config defaults over an old blob, and edge `mode` absent on stored rows.
  - Migration over a pre-phase database.
- `e2e/specs/shipping-stacking.spec.ts`:
  - The card sets the default and survives a reload.
  - A dependency chip toggles mode in the dispatch form and the backlog editor.
  - A stack-released backlog card shows *Stacked on #N*.
  - The merge queue shows the `stacked-base` hold for a fake PR whose base is not `main`.
  - The merge queue shows the `stack-hold` hold for a fake stacked PR already on `main`
    whose compare result is not `ahead`.
  - Extend `e2e/fixtures/fake-agents.ts` so `api graphql` returns `baseRefName`, the
    merge commit and the default branch, the compare endpoint returns a scripted status,
    and the PR PATCH succeeds. No model tokens, no `data-testid`.
- Then `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and
  `npm run test:e2e`.

## 8. Merge and exit criteria

- All of the above pass.
- With the setting off and no chip set to Stack, behavior and existing tests are
  unchanged.
- With it on, a stacked child starts, is pinned to the parent head, and opens on (or is
  corrected to) the parent base. It is held by `stacked-base` while its base is the
  parent branch. After any retarget, including GitHub's automatic one, it is held by
  `stack-hold` until the release check passes for its current head. A person can satisfy
  that check by hand, and Phase 2 automates it.
- Switching the setting off after a child started does not release it.

## 9. Downstream handoff

Phase 2 relies on the contract names in the index, unchanged:

- the edge readiness stamp and `effectiveEdgeMode` / `stackEligibility`;
- the `Task.stack*` fields;
- `PrSnapshot.baseRefName` / `defaultBranch` / `mergeCommitSha` and
  `inspector_prs.base_ref_name`;
- PR-row lineage (`stack_parent_pr_url` as the current parent, `stack_base_sha`,
  `stack_released_head_sha`), `stackReleased` evaluated against the current parent, and
  the compare helper;
- the base-aware clean-review record and the stacked review diff base;
- lineage seeding and inheritance (`stack_task_id` plus repository,
  `stack_lineage_history`), the primary-repository scope, and `expectedStackBase`, shared
  by the PR-opening instruction and base correction;
- `MergeBlock` `"stacked-base"` and `"stack-hold"`;
- the REST retarget helper written in step 6, reused by Phase 2.

Phase 2 must not move or weaken either gate, add a new gate, change the release check,
change edge or `satisfiedAt` semantics, or add a second dispatch-base path. Phase 2 may
change `stack_parent_pr_url` only through its replacement-parent transition, and must never
change `stack_base_sha`.

## 10. Cross-phase audit record

- Written first. Owns every shared name that Phase 2 consumes.
- Took source-plan §8 (base-aware review) from the lifecycle work, because GitHub can
  retarget a child by itself before Phase 2 exists.
- The retarget helper is introduced here for base correction, so Phase 2 reuses it rather
  than adding a second GitHub write path.
- Repair round 1: added the PR-row lineage, the `stack-hold` gate, `mergeCommitSha`, the
  compare helper and `stackReleased`. With them, a child that GitHub retargets
  automatically (or that receives an unrelated push) stays held until ancestry proves the
  restack, and the hold outlives the setting being switched off. The steps were
  renumbered: the release check is step 8, the gates step 9, UI step 10, docs step 11.
- Repair round 2:
  - Added `stack_base_sha` to the PR-row lineage and to the closed-parent branch, so a
    parent that pushed before closing cannot release a child that still carries the
    commit it was cut from.
  - Made `stack_parent_pr_url` the current parent, changeable only by Phase 2's
    replacement transition.
  - Added step 9 (the review diff base) as the owner of the base-relative Persona diff.
  - Steps renumbered again: gates 10, UI 11, docs 12.
- Repair round 3:
  - Step 7 now seeds lineage from the task only for the task's first child PR. Later
    child PRs inherit the previous row's current parent, stack base and history.
    `stack_task_id` and `stack_lineage_history` are created here.
  - Step 6's base correction now follows the current parent's state, so the
    *Move onto main* replacement keeps its default base.
  - Tests cover both.
- Repair round 4:
  - Step 6 now has one `expectedStackBase` for both the instruction and the correction.
  - Steps 2, 5 and 7 limit stacking and lineage to the primary repository, and key
    inheritance by task plus repository.
  - Tests cover the instruction for a replacement child and the multi-repository scope.
- Repair round 5: step 4 now stamps readiness only from the prerequisite's
  primary-repository PR, with a test that a secondary-repository PR cannot supply the
  stack base or release the dependent.
- Repair round 6:
  - Step 9 now refreshes the review base at the repository root, verifies it against
    `ls-remote`, and diffs against the verified SHA, failing visibly otherwise. A
    stale-base test was added.
  - Section 3's non-goal now names worktree mutations rather than all git use.
- PR #1359 review:
  - Step 3 treats an absent `stackReadyAt` as unstamped.
  - Step 10 scopes `stacked-base` to PRs with lineage, so PRs without lineage keep their
    current merge behavior.
  - Tests cover both.
- PR #1359 re-review (GitHub Inspector): step 5 now revalidates the parent PR (open,
  non-draft, stamped URL, branch and current episode) at dispatch before accepting the
  pin. A stale stamp refuses the dispatch and is cleared. A test was added.
