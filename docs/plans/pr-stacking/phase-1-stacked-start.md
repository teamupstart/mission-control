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
scope: force-pushing, git operations by the daemon inside a worktree, cross-repository
stacking.

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
   - prerequisite and dependent share a repository (compare the primary repository and
     the attached repositories the prerequisite changed);
   - exactly one unmerged same-repository prerequisite remains;
   - every cross-repository prerequisite is satisfied;
   - the parent's own stack depth is below `maxStackDepth`.

   It returns `{ ok: true, edge }` or `{ ok: false, reason }` with a short reason the board
   can show.
3. **Shared blocker read** (`src/shared/backlog.ts`). In `declaredBlockersIn`, an edge that
   `stackEligibility` selects, and that has `stackReadyAt !== null`, does not block
   *starting*. Its `satisfiedAt` stays null. Leave `dependencyState` and inferred plan
   edges unchanged. Add a `stacked` flag to the readiness result if the board needs it, not
   a new `BlockerState`, so every exhaustive switch keeps compiling.
4. **Readiness stamping** (`src/server/tasks.ts`, next to `satisfyDeclaredEdgesTo`). When
   a prerequisite's session goes idle with an empty queue on its current episode, and that
   episode's observed PR is open and not a draft, write `stackReadyAt`, `stackBaseBranch`
   (the PR head ref), `stackBaseSha` and `stackPrUrl` on every dependent edge whose
   effective mode is stack. Reuse the idle, queue and episode checks from
   `settleIfEpisodeFinished`. Clear the stamp on edges whose dependent has not started yet
   if the prerequisite leaves that state (a new turn, a draft, a closed PR). Persist
   through the existing `tasks.dependencies` JSON write. Emit the normal task upsert so the
   UI updates.
5. **Pinned dispatch** (`TaskManager.dispatch`, `src/server/dispatcher.ts`). When the
   dependent is stack-released, fetch the parent branch from origin, read its current head
   SHA (newer than the stamp if the parent pushed since), and pass it as `baseSha`. On
   success, persist `stack_parent_task_id`, `stack_base_branch`, `stack_base_sha` and
   `stack_pr_url` (`addColumn` in the `tasks` upgrade path in `src/server/db.ts`, beside
   `base_sha`). If the fetch or the pin fails, refuse the dispatch with the reason. Never
   fall back to `main` silently. Manual dispatch, assign, drag-to-assign and the autopilot
   all reach this through `dependencyBlockers`. Check each one.
6. **Stacked PR base**. In `withTaskKindContract` (`src/server/task-contract.ts`), and in
   the runtime PR packet where the workflow's pull-request action is sent, append for a
   stacked task: *open the pull request with `--base <stackBaseBranch>` and start the
   description with "Stacked on <stackPrUrl>".* Change the source text through
   `actions/pull-request.md` and `npm run session-actions` only if a static line is
   needed. Never edit the generated file. Then enforce it. When the Inspector adopts a PR
   for a stacked task's session, compare the snapshot's `baseRefName` with
   `stackBaseBranch`. If they differ, retarget it through the GitHub REST API (`PATCH
   repos/{owner}/{repo}/pulls/{n}` with `base`, the same `gh api` style as `mergePr`) and
   record a one-line note on the PR row.
7. **Snapshot base fields and lineage** (`src/server/inspector/github.ts`,
   `src/server/db.ts`, `InspectorPr`).
   - Add `baseRefName`, `mergeCommit { oid }` and `repository { defaultBranchRef { name } }`
     to `PR_QUERY`. Expose them as `PrSnapshot.baseRefName`, `mergeCommitSha` and
     `defaultBranch`. Persist `inspector_prs.base_ref_name`.
   - Record the base next to the clean-review head (`cleanReviewHeadSha`), so a base that
     changes under the same head counts as not reviewed.
   - When a PR is adopted for a session whose task has `stackPrUrl`, copy it into the new
     `inspector_prs.stack_parent_pr_url`. It is set once and never cleared by the
     Shipping setting or the edge mode.
   - Add `inspector_prs.stack_released_head_sha`, null on adoption.
8. **Release check** (`src/shared/stacking.ts`, `src/server/inspector/`). Add the pure
   `stackReleased(facts)` with exactly the two branches in source plan §7:
   - parent merged: the base is the default branch and the parent merge commit is an
     ancestor of the child head;
   - parent closed unmerged: the base is the default branch and the parent's last
     observed head is not an ancestor of the child head.

   Any unknown fact returns held. On each Inspector tick, for a row with lineage and no
   release for its current head, read the parent row's state, merge commit and last head.
   Ask GitHub's compare API (`gh api repos/{o}/{r}/compare/{ancestor}...{head}`; `ahead`
   or `identical` means it is an ancestor). On a pass, write
   `stack_released_head_sha = <current head>`. Never run git in a worktree for this.
9. **Merge gates** (`src/shared/shipping.ts`, `src/server/shipping/merge.ts`). Add
   `baseRefName`, `defaultBranch` and `stack: { lineage: boolean; releasedForHead: boolean }`
   to `MergeInput.pr`. Add two `MergeBlock`s, each with a `MERGE_BLOCK_LABEL`, evaluated
   in this order after `draft` and before the workflow and review gates:
   - `"stacked-base"`: the base is not the default branch, or either value is unknown
     (fail closed);
   - `"stack-hold"`: lineage is present and `stack_released_head_sha` does not equal the
     current head.

   Pass both from `maybeMerge`. Make `not-reviewed` cover a reviewed base that differs
   from the current base.
10. **UI** (`ShippingSettingsPanel.tsx`, `DispatchModal.tsx`, `backlog-copy.ts`,
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
11. **Docs**. `docs/inspector-and-shipping.md`: a new *Stacked pull requests* section,
    both gate rows, the release check including how a person satisfies it by hand, and
    the base-aware review rule. `docs/dispatch-and-backlog.md`: edge
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
  - `declaredBlockersIn` with stamped and unstamped stack edges.
  - Stamping and clearing transitions.
  - Pinned dispatch, plus refusal when the fetch fails.
  - Base correction on adoption.
  - `mergeVerdict` refusing a non-default base and an unknown base.
  - `stack-hold`:
    - still holds after the base changes to the default branch with an unchanged head
      (an automatic retarget);
    - still holds after a new head that does not contain the parent's merge commit
      (an unrelated push);
    - releases only when the compare call shows ancestry;
    - re-checks after a later head;
    - holds on a compare failure;
    - releases on the closed-parent branch once the child no longer contains the
      parent's head;
    - still holds with the setting switched off.
  - Lineage copied at adoption and never cleared.
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
- PR-row lineage (`stack_parent_pr_url`, `stack_released_head_sha`), `stackReleased` and
  the compare helper;
- the base-aware clean-review record;
- `MergeBlock` `"stacked-base"` and `"stack-hold"`;
- the REST retarget helper written in step 6, reused by Phase 2.

Phase 2 must not move or weaken either gate, add a new gate, change the release check,
change edge or `satisfiedAt` semantics, or add a second dispatch-base path.

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
