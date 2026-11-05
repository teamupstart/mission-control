# Phase 2: Stack lifecycle

Source plan: `docs/plans/pr-stacking/plan.md`. Index: `docs/plans/pr-stacking/phased-plan.md`.
Prerequisite: `docs/plans/pr-stacking/phase-1-stacked-start.md`. This file is the proposed
route, not a specification. Where the repository disagrees, follow the repository and
record the deviation in the pull request.

## 1. Outcome

A stack keeps itself landable. When the parent picks up new commits, the child's session
is asked to merge the parent branch in. When the parent merges, the daemon retargets the
child to the default branch and asks its session to merge the new base in and push, with
no force-push. Once Phase 1's release check verifies the restack, the child is re-reviewed
and merges through the ordinary gates, so under YOLO mode a stack lands bottom-up on its
own. When a stack breaks, the child is held
with a named reason and an action that fixes it.

## 2. Entry criteria

- Phase 1 has merged. This phase depends on Phase 1 only.

## 3. Scope and non-goals

In scope: source plan §5 (parent moved), §6 (retarget and merge-based restack), §9
(broken stacks), the merge-queue lifecycle states, the manual send when Foreman is off,
and their docs.

Not in scope: any change to Phase 1's names, its two gates (`stacked-base`,
`stack-hold`), the release check, edge semantics or the dispatch pin. This phase adds no
gate. It brings children to the state that Phase 1's release check accepts.

Scope rule (from the index): the Shipping default and edge `mode` decide only whether a
dependent starts early. Everything in this phase applies to every PR row with recorded
lineage, whatever the setting says. Never in scope: force-pushing, rebasing, or any git
operation by the daemon that changes a worktree's checkout, branches or commits. The
daemon only reads pull requests, edits their base, prompts sessions, and uses the
read-only diffs and repository-root fetches it already performs.

## 4. Inherited contracts and findings

From Phase 1:

- `Task.stackParentTaskId`, `stackBaseBranch`, `stackBaseSha`, `stackPrUrl`;
- `PrSnapshot.baseRefName` / `defaultBranch` and `inspector_prs.base_ref_name`;
- the base-aware clean-review record;
- PR-row lineage (`stack_parent_pr_url` as the current parent, `stack_base_sha`,
  `stack_released_head_sha`), `stackReleased` evaluated against the current parent, and
  the compare helper;
- the stacked review diff base, which follows the PR's current base, so a retarget or a
  lineage transition needs no extra diff work here;
- `MergeBlock` `"stacked-base"` and `"stack-hold"`;
- the REST retarget helper.

Repository findings: CodeRabbit follow-up delivery is
`codeRabbitCandidate` / `codeRabbitStanding` (`src/server/inspector/code-rabbit-delivery.ts`),
`claimCodeRabbit` / `finishCodeRabbit` (`src/server/db.ts`), and Foreman's
`decideReviewFollowup` / `buildPayload` (`src/server/foreman/review-followup.ts`), sent
through `POST /api/sessions/:id/inject` with a guard and a claim before delivery
(`src/server/routes.ts`). The Inspector tick is `processPr` → `maybeMerge` in
`src/server/inspector/worker.ts`. `src/server/skills/reload.ts` explains why the daemon
must not become a second unleased autonomous writer.

## 5. Implementation steps

1. **Behind-base signal** (`src/server/inspector/github.ts`). Add `mergeStateStatus` and
   the base comparison to the snapshot (a behind-by count through REST `compare` when
   needed). Name it generically, without "stack" in the field names, so
   `docs/plans/pr-behind-base/plan.md` can reuse it for default-branch staleness later.
2. **Stack state** (new `src/server/stacking/state.ts`, pure parts in
   `src/shared/stacking.ts`). For each PR row with `stack_parent_pr_url`, derive one of
   the following. Derive from the row's lineage, not from the task or the setting, so it
   works after the session is gone and with stacking switched off.
   - `current`;
   - `parent-moved`: the parent head is not an ancestor of the child head;
   - `parent-merged-needs-retarget`;
   - `restack-needed`: on the default branch, but the release check has not passed for
     the current head. Any head that does not contain the parent's merge commit counts
     here, including one changed by an unrelated push;
   - `broken`: the parent closed unmerged, the parent task was rescheduled or cancelled,
     or the child was closed by a base deletion;
   - `released`: `stack_released_head_sha` equals the current head, meaning Phase 1's
     release check verified it.

   Keep it on the PR row (a new nullable `inspector_prs.stack_state` column, or a derived
   read). It is not a second task status, and it never releases anything itself. Only
   `stackReleased` writes the release.
3. **Retarget on parent merge** (Inspector tick). When the parent PR is observed merged,
   retarget each open child to the parent's base with the Phase 1 helper. The retarget is
   idempotent: it is skipped when `baseRefName` already matches, which covers GitHub's own
   auto-retarget. The base-aware review record forces a re-review, and `stack-hold` keeps
   the child held until the restack is verified.
4. **Prompts** (new `src/server/stacking/delivery.ts`, Foreman `review-followup.ts`). Add
   two follow-up kinds to the existing review-follow-up path:
   - *catch up*: merge the parent branch in and push;
   - *restack*: merge `origin/<default branch>` in, resolve conflicts, run focused checks,
     push, no force-push.

   Each gets its own claim key per PR, head and state, following `claimCodeRabbit`, and the
   same guards: a single live owning session, idle, no queued work, no active workflow, no
   restart of an absent session. Claim before send, release only on confirmed
   non-delivery. When no live session owns the child, nothing is sent and the merge queue
   shows *Restack needed: no session*. The claim key does not include the session, so
   when the operator resumes the task with the existing **Resume** control, the pending
   prompt is delivered once to the resumed session on its first idle tick. When Foreman is
   off or not invited, nothing is sent. The merge queue shows
   *Restack needed: Foreman is off* with a **Send restack prompt** button that uses the
   same inject route and guard.
5. **Broken stacks** (server plus `BacklogColumn.tsx`, the Line row,
   `ShippingSettingsPanel.tsx`). The child is already held by `stacked-base` or
   `stack-hold`. `mergeBlock` carries *Stack broken: #A closed*. Offer these actions, by
   state:
   - **Move onto main**: prompt the session to cherry-pick only its own commits onto a new
     branch cut from the default branch, open a replacement PR and close the old one.
     Phase 1's adoption makes the replacement inherit the previous child row's current
     parent, stack base and lineage history (not the task's dispatch-time fields). Phase
     1's base correction leaves it on the default branch because its current parent is
     closed. It is released only when the closed-parent branch of the release check
     passes, which means it contains neither the stack base nor the parent's last head.
   - **Reopen against main** (child PR closed by GitHub after its base branch was deleted,
     current parent **merged**): prompt the session to open a new PR from the same child
     branch. Phase 1's instruction names the default branch, because the parent merged.
     Phase 1's adoption makes it inherit the closed row's lineage. The restack prompt and
     the merged-parent branch of the release check then apply as usual. If the current
     parent **closed** without merging, a closed child gets only *Move onto main*.
   - **Wait for a replacement**: the *replacement-parent transition*, the only writer
     that changes `stack_parent_pr_url`. It runs only when the child PR is still open,
     the child is `broken` because its current parent closed unmerged, and the existing
     branch discovery finds a
     replacement PR on the closed parent's same task episode. In one transaction it
     appends `{from, to, at}` to `inspector_prs.stack_lineage_history` (a column created by
     Phase 1), sets `stack_parent_pr_url` to the replacement, and clears
     `stack_released_head_sha`.
     `stack_base_sha` stays unchanged. The transition is idempotent: the same
     replacement URL is a no-op.

     It then retargets the child to the replacement's branch with the Phase 1 helper (the
     replacement is open, so this matches Phase 1's expected-base rule) and sends a
     catch-up prompt. Because the release check reads the current parent, the
     child is released through the merged-parent branch: once the replacement merges, the
     child is retargeted to the default branch, restacks, and the replacement's merge
     commit is in its ancestry. If the replacement also closes unmerged, the child is
     `broken` again and the same two actions apply.

   A rescheduled or cancelled parent also shows in the existing stopped-dependency warning
   button's text. An edge flipped to *After merge* after the child started changes nothing
   for that child.
6. **Merge-queue copy** (`src/shared/shipping.ts` labels, `src/web/lib/pr-standing.ts`).
   Rows read *Stacked on #A (waiting for it to merge)*, *Catching up with #A*,
   *Restacking onto main*, *Restack needed: no session*, *Restack needed: Foreman is off*
   and *Stack broken: #A closed*. Keep Phase 1's `stacked-base` and `stack-hold` as the
   only stacking gates. These are reasons that refine their text, not new gates. Bucket them as `blocked`, except
   *Restacking onto main*, which is in progress and belongs with `waiting`.
7. **Docs**. `docs/inspector-and-shipping.md`: lifecycle, prompts, broken stacks
   (including the replacement-parent transition and its lineage history) and the Foreman
   dependency. `docs/dispatch-and-backlog.md`: what a stacked task does after its
   parent merges.

## 6. Data and compatibility

- Any new column is nullable and added through `addColumn`. `stack_lineage_history` is
  Phase 1's column; this phase only appends to it. Rows from Phase 1 read as
  `current`, `parent-merged-needs-retarget`, `restack-needed` or `released` on the first
  tick, from their lineage and release record.
- Claim rows reuse the CodeRabbit claim table shape, or a sibling table created in the
  upgrade path. They are never re-armed by restarts, pushes or toggles, matching CodeRabbit
  semantics.
- Children retargeted by hand or by GitHub before this phase are observed as
  `restack-needed` or `released` from Phase 1's release record. Nothing is replayed.

## 7. Tests and verification

- `test/`:
  - The stack-state derivation table, including a changed head without the parent merge
    commit staying `restack-needed`, and lineage rows deriving correctly with the
    setting off and no session.
  - Retarget idempotence, including GitHub having already retargeted.
  - The claim lifecycle: no duplicate prompt across ticks, a restart or a push; release
    on confirmed non-delivery.
  - Guards: busy session, queued work, absent session, active workflow, Foreman off.
  - *Resume* recovery: with no session the row reads *Restack needed: no session* and
    nothing is sent. After the task is resumed, the pending prompt is delivered exactly
    once on the resumed session's first idle tick.
  - Prompts still go out for an already-stacked child after the Shipping default is
    switched off.
  - Broken-stack holds.
  - A child closed by base deletion:
    - with a merged parent, *Reopen against main* produces a new PR against the default
      branch that inherits the lineage and is released after restacking;
    - with a closed parent, only *Move onto main* is offered;
    - *Wait for a replacement* is never offered for a closed child.
  - Replacement-parent transition:
    - it appends to the history, swaps the current parent, keeps `stack_base_sha`, and
      clears the release;
    - it is idempotent;
    - it runs only for a `broken` child with a same-episode replacement;
    - the replacement's merge plus a restack releases the child;
    - a replacement that closes unmerged returns the child to `broken`.
  - Sequence test: the original parent P1 closes, the replacement-parent transition swaps
    in P2, P2 also closes, and the session runs *Move onto main*. The new child PR
    inherits P2 as its current parent, with the unchanged stack base and exactly one
    history entry (`P1 to P2`). It
    stays on the default branch, and it is released only by the closed-parent check
    against P2 and the stack base.
  - A git-level fixture: cut from the parent, squash-merge the parent, merge
    `origin/main` into the child, and assert the child's diff against `main` is only its
    own change.
- `e2e/specs/shipping-stacking.spec.ts`, extended:
  - The merge queue shows *Restack needed: Foreman is off* and its button sends through a
    fake session.
  - A closed fake parent shows *Stack broken* on the backlog card and in the merge queue,
    with both actions reachable.
  - After a fake replacement parent is discovered, the row reads *Stacked on* the
    replacement.
  - Extend the fake `gh` for parent-merged and closed states and the PR PATCH.
- Then `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and
  `npm run test:e2e`.

## 8. Merge and exit criteria

- All of the above pass.
- With YOLO mode, Inspector and Foreman on, and a fake or real two-PR stack, the child
  lands after the parent with no human step except conflicts.
- With stacking off and no PR rows carrying lineage, nothing in this phase acts.
- Children that already carry lineage keep the full lifecycle (catch-up, retarget,
  restack prompts and broken-stack handling) whatever the setting says. They stay held
  until Phase 1's release check passes.

## 9. Downstream handoff

This is the last phase. Later work, including `pr-behind-base`, may reuse the generic
behind-base snapshot fields and the follow-up delivery kinds. It must not merge stacked
children into non-default bases or add a daemon-side writer that types into panes.

## 10. Cross-phase audit record

- Consumes Phase 1 names unchanged.
- Repair round 2:
  - Defined the replacement-parent transition as the only writer of a changed
    `stack_parent_pr_url`, with `stack_lineage_history`, so waiting for a replacement
    ends in a release through the merged-parent branch.
  - `stack_base_sha` is never touched here.
- Repair round 3:
  - *Move onto main* replacements rely on Phase 1's inheritance and base-correction rules
    instead of the task's lineage.
  - `stack_lineage_history` moved to Phase 1, and this phase only appends to it.
  - A sequence test covers a replacement parent that also closes.
- Repair round 4:
  - The sequence test now expects exactly one history entry.
  - Added *Reopen against main* for a child closed by base deletion when its parent
    merged.
  - The replacement-parent transition now requires an open child PR.
  - Everything here inherits Phase 1's primary-repository scope.
- Repair round 5:
  - Step 4 defines the *Resume* recovery for a child with no session, with a test.
  - Step 5's wording now says actions are offered by state.
- Repair round 6: the non-goal wording now matches Phase 1. After a retarget, the review
  diff's base refresh is Phase 1's (step 9), so this phase adds nothing for it.
  - The base-relative Persona diff is Phase 1's (step 9) and follows the current base
    automatically.
- Repair round 1: Phase 1 now owns `stack-hold`, the lineage and the release check.
  `unstacked` became `released` (verified ancestry, not any new head). The state is
  derived from row lineage so it outlives the setting and the session. The exit criteria
  now state that already-stacked children keep their lifecycle with stacking off.
- Restack and catch-up prompts use Foreman's review-follow-up path instead of a new
  daemon-side writer. This honors the source plan's "same delivery rules as the CodeRabbit
  follow-up" and the boundary in `src/server/skills/reload.ts`. When Foreman is off, the
  stack is held visibly, with a manual send.
