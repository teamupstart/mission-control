# Phase 2: Stack lifecycle

Source plan: `docs/plans/pr-stacking/plan.md`. Index: `docs/plans/pr-stacking/phased-plan.md`.
Prerequisite: `docs/plans/pr-stacking/phase-1-stacked-start.md`. This file is the proposed
route, not a specification. Where the repository disagrees, follow the repository and
record the deviation in the pull request.

## 1. Outcome

A stack keeps itself landable. When the parent picks up new commits, the child's session
is asked to merge the parent branch in. When the parent merges, the daemon retargets the
child to the default branch and asks its session to merge the new base in and push, with
no force-push. The child is then re-reviewed and merges through the ordinary gates, so
under YOLO mode a stack lands bottom-up on its own. When a stack breaks, the child is held
with a named reason and an action that fixes it.

## 2. Entry criteria

- Phase 1 has merged. This phase depends on Phase 1 only.

## 3. Scope and non-goals

In scope: source plan §5 (parent moved), §6 (retarget and merge-based restack), §9
(broken stacks), the merge-queue lifecycle states, the manual send when Foreman is off,
and their docs.

Not in scope: any change to Phase 1's names, gate position, edge semantics or dispatch
pin. Never in scope: force-pushing, rebasing, or any git operation by the daemon inside a
worktree. The daemon only reads pull requests, edits their base and prompts sessions.

## 4. Inherited contracts and findings

From Phase 1:

- `Task.stackParentTaskId`, `stackBaseBranch`, `stackBaseSha`, `stackPrUrl`;
- `PrSnapshot.baseRefName` / `defaultBranch` and `inspector_prs.base_ref_name`;
- the base-aware clean-review record;
- `MergeBlock` `"stacked-base"`;
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
   `src/shared/stacking.ts`). For each adopted PR whose session belongs to a task with
   `stackParentTaskId`, derive one of:
   - `current`;
   - `parent-moved`: the parent head is not an ancestor of the child head;
   - `parent-merged-needs-retarget`;
   - `restack-needed`: retargeted but still carrying the parent's original commits, so
     the head has not changed since the retarget;
   - `broken`: the parent closed unmerged, the parent task was rescheduled or cancelled,
     or the child was closed by a base deletion;
   - `unstacked`: on the default branch with a new head since the retarget.

   Keep it on the PR row (a new nullable `inspector_prs.stack_state` column, or a derived
   read). It is not a second task status.
3. **Retarget on parent merge** (Inspector tick). When the parent PR is observed merged,
   retarget each open child to the parent's base with the Phase 1 helper. The retarget is
   idempotent: it is skipped when `baseRefName` already matches, which covers GitHub's own
   auto-retarget. The base-aware review record then forces re-review on its own.
4. **Prompts** (new `src/server/stacking/delivery.ts`, Foreman `review-followup.ts`). Add
   two follow-up kinds to the existing review-follow-up path:
   - *catch up*: merge the parent branch in and push;
   - *restack*: merge `origin/<default branch>` in, resolve conflicts, run focused checks,
     push, no force-push.

   Each gets its own claim key per PR, head and state, following `claimCodeRabbit`, and the
   same guards: a single live owning session, idle, no queued work, no active workflow, no
   restart of an absent session. Claim before send, release only on confirmed
   non-delivery. When Foreman is off or not invited, nothing is sent. The merge queue shows
   *Restack needed: Foreman is off* with a **Send restack prompt** button that uses the
   same inject route and guard.
5. **Broken stacks** (server plus `BacklogColumn.tsx`, the Line row,
   `ShippingSettingsPanel.tsx`). Hold the child: `stacked-base` already blocks it, and
   `mergeBlock` carries *Stack broken: #A closed*. Offer two actions:
   - **Move onto main**: prompt the session to cherry-pick only its own commits onto a new
     branch cut from the default branch, open a replacement PR and close the old one.
   - **Wait for a replacement**: when the existing branch discovery finds a replacement
     parent PR on the same episode, it becomes the new base, through a retarget plus a
     catch-up prompt.

   A rescheduled or cancelled parent also shows in the existing stopped-dependency warning
   button's text. An edge flipped to *After merge* after the child started changes nothing
   for that child.
6. **Merge-queue copy** (`src/shared/shipping.ts` labels, `src/web/lib/pr-standing.ts`).
   Rows read *Stacked on #A (waiting for it to merge)*, *Catching up with #A*,
   *Restacking onto main*, *Restack needed: no session*, *Restack needed: Foreman is off*
   and *Stack broken: #A closed*. Keep `stacked-base` as the single gate. These are
   reasons that refine it, not new gates. Bucket them as `blocked`, except
   *Restacking onto main*, which is in progress and belongs with `waiting`.
7. **Docs**. `docs/inspector-and-shipping.md`: lifecycle, prompts, broken stacks and the
   Foreman dependency. `docs/dispatch-and-backlog.md`: what a stacked task does after its
   parent merges.

## 6. Data and compatibility

- Any new column is nullable and added through `addColumn`. Rows from Phase 1 read as
  `current` or `parent-merged-needs-retarget` on the first tick.
- Claim rows reuse the CodeRabbit claim table shape, or a sibling table created in the
  upgrade path. They are never re-armed by restarts, pushes or toggles, matching CodeRabbit
  semantics.
- Children retargeted by hand before this phase are observed as `restack-needed` or
  `unstacked` from their heads. Nothing is replayed.

## 7. Tests and verification

- `test/`:
  - The stack-state derivation table.
  - Retarget idempotence, including GitHub having already retargeted.
  - The claim lifecycle: no duplicate prompt across ticks, a restart or a push; release
    on confirmed non-delivery.
  - Guards: busy session, queued work, absent session, active workflow, Foreman off.
  - Broken-stack holds.
  - A git-level fixture: cut from the parent, squash-merge the parent, merge
    `origin/main` into the child, and assert the child's diff against `main` is only its
    own change.
- `e2e/specs/shipping-stacking.spec.ts`, extended:
  - The merge queue shows *Restack needed: Foreman is off* and its button sends through a
    fake session.
  - A closed fake parent shows *Stack broken* on the backlog card and in the merge queue,
    with both actions reachable.
  - Extend the fake `gh` for parent-merged and closed states and the PR PATCH.
- Then `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and
  `npm run test:e2e`.

## 8. Merge and exit criteria

- All of the above pass.
- With YOLO mode, Inspector and Foreman on, and a fake or real two-PR stack, the child
  lands after the parent with no human step except conflicts.
- With stacking off, nothing in this phase runs.

## 9. Downstream handoff

This is the last phase. Later work, including `pr-behind-base`, may reuse the generic
behind-base snapshot fields and the follow-up delivery kinds. It must not merge stacked
children into non-default bases or add a daemon-side writer that types into panes.

## 10. Cross-phase audit record

- Consumes Phase 1 names unchanged. No Phase 1 edits were required.
- Restack and catch-up prompts use Foreman's review-follow-up path instead of a new
  daemon-side writer. This honors the source plan's "same delivery rules as the CodeRabbit
  follow-up" and the boundary in `src/server/skills/reload.ts`. When Foreman is off, the
  stack is held visibly, with a manual send.
