# Phase 6: Shipping on local provenance

Source plan: `docs/plans/local-inspector-review/plan.md`. Index:
`docs/plans/local-inspector-review/phased-plan.md`.

## 1. Outcome

YOLO mode can merge a pull request whose head was reviewed by the Local Inspector, and holds
any head that was not. Repositories with the merge grant stop needing a GitHub review for
locally reviewed work.

## 2. Entry criteria and dependencies

- Direct dependency: Phase 5 (Local review replaces the GitHub round) is merged.

## 3. Scope and non-goals

In scope: the merge predicate's acceptance of a `local` posture, one new block reason, the
merge queue and Prerequisites copy, tests and docs.

Not in scope: every other merge gate. CI, soak, unresolved threads, requested changes, the
default-branch rule, stack release and the merge grant are untouched. Dry run still means dry
for the merge.

## 4. Repository findings and inherited contracts

- `mergeVerdict` in `src/shared/shipping.ts` is the pure merge predicate. `MergeBlock` and
  `MERGE_BLOCK_LABEL` name each refusal.
- It checks posture twice. Its first gate reads the Inspector's current posture and refuses
  while that is off, `dry-run` or `not-allowlisted`. A later check reads the posture recorded
  with the reviewed head and refuses anything but `live` as `review-unpublished`.
- The worker calls the predicate from `processPr` on every sweep, before any review.
- `docs/inspector-and-shipping.md` documents the gates under "What has to be true".
- Inherited from Phase 5: the manager's match question, the `local` posture recorded for a
  matched head, and the merge-grant exception this phase removes.

## 5. Implementation steps

1. Extend the predicate's input with the facts it needs: whether `localReview` is on, and
   whether the manager reports a match for the head being evaluated.
2. In `mergeVerdict`, at the recorded-posture check, treat a recorded `local` posture as review
   provenance only when all of these hold: the Inspector's current posture is `live`,
   `localReview` is on, the recorded head is the observed head, the manager still reports the
   match, and the reviewed base is the pull request's base. Otherwise refuse with a new
   appended reason for a missing local review. A later commit with the same tree is recorded
   as `local` by the worker on its next sweep and merges only after that.
3. Leave every other gate in its place and order. The current-posture gate stays first, so
   while the Inspector is off, in Dry run, or the repository is not on its list, nothing
   merges, a matching local pass included, and the refusal is the existing `inspector-off`,
   `inspector-dry-run` or `inspector-not-allowlisted` reason. A recorded `dry-run` or
   `not-allowlisted` posture is refused exactly as today.
4. Pass the new facts from `processPr`, and remove Phase 5's merge-grant exception from the
   manager's match in the same change. The compare-and-swap on the evaluated head stays.
5. UI: the new reason in the merge queue and the Prerequisites card in
   `src/web/components/ShippingSettingsPanel.tsx`, and the Trust copy that explains which
   review a merge relies on.
6. Update the gates table and the "It needs the GitHub Inspector, fully on" section in
   `docs/inspector-and-shipping.md`.

## 6. Data, API and compatibility

- One block reason is appended. No stored value is renamed.
- With `localReview` off, the predicate behaves exactly as before this phase.
- Dry run stays dry. A matching local pass cannot merge while the Inspector is in Dry run:
  Phase 5 never records it as `local`, and the current-posture gate refuses first.
- A push after the local pass that changes the tree no longer matches, so the head needs a
  GitHub review, as any "other head" does. A later commit with the same tree and base still
  matches: the worker records the new head as `local` on its next sweep, and until then the
  predicate refuses it because the recorded head is not the observed head.

## 7. Tests and verification

- Predicate tests in `test/shipping-merge.test.ts`: a matched local head merges once the other
  gates pass; an unreviewed head and a later push that changes the tree are refused; a later
  commit with the same tree merges once the worker has recorded it and is refused before
  that; `localReview` off
  refuses a `local` posture; a base change is refused; a matching local pass while the
  Inspector is in Dry run is refused as `inspector-dry-run`, whether the head is recorded as
  `dry-run` or, defensively, as `local`.
- Gate and worker tests: a repository holding the merge grant now takes the local path.
- Panel tests beside `test/shipping-panel-warnings.test.ts` for the new reason.
- Playwright: the merge queue showing the new reason and a locally reviewed head as eligible.
- Run `npm run typecheck`, `npm run lint`, the focused tests, `npm run build`,
  `npm run smoke` and `npm run test:e2e`.

## 8. Merge and exit criteria

- A locally reviewed head merges under YOLO when every other gate is green.
- No head merges on a local review that does not match it.
- Behavior with `localReview` off is unchanged.
- Nothing merges while the Inspector is in Dry run, a matching local pass included.

## 9. Downstream handoff

Nothing depends on this phase. It completes the plan.

## 10. Cross-phase audit record

- 2026-11-23: checked against Phase 5. This phase reads the posture and removes the match's
  merge-grant exception. It adds no second owner of the match.
- 2026-11-23: checked against the source plan's decision D2 and its rule that Dry run means
  dry for the merge. Both hold.
- 2026-11-23: Plan Validation review. Steps 2 and 3 now say where Dry run is checked for a
  locally reviewed head, and the tests cover a matching local pass in Dry run.
- 2026-11-23: Plan Validation review, second round. Section 6 and the tests use the plan's
  tree-based match for a later push: the same tree still matches, a changed tree does not.

## 11. Implementation record

What was built, and where it follows or departs from the route above.

### The predicate

`MergeInput` gained `localReview: { enabled, matchedHeadSha }`: whether
`InspectorConfig.localReview` is on (it reads as off while the `local-inspector` flag is off), and
the head the workflow manager's `localReviewMatch` reported a match for on this sweep. `maybeMerge`
fills it from the sweep's Inspector config and the match `processPr` already asked for, so the
predicate reads Phase 5's single owner and adds no second one.

In `mergeVerdict` a recorded `local` posture is accepted at the recorded-posture check only when
Local review is on and the reported match names the observed head. The current-posture gate stays
first and unchanged, so Dry run, an Inspector switched off and a repository off its list refuse
first, a matching local pass included. A recorded `dry-run` or `not-allowlisted` posture is still
`review-unpublished`. The appended block reason is `local-review-missing`.

### Deviations from the route

- The round count is asked only of a GitHub review. A head recorded from a local match has no
  GitHub round (`round` stays 0), and the existing `rounds < 1` arm of `not-reviewed` would
  otherwise refuse every local head.
- "The recorded head is the observed head" and "the reviewed base is the pull request's base" are
  answered by the existing `not-reviewed` check, which already runs before the posture check, so a
  later commit with the same tree reads `not-reviewed` until the worker records it rather than the
  new reason. `local-review-missing` is reserved for a head recorded `local` on this push whose
  backing is gone: Local review switched off, or the manager no longer matching it.
- `repositoryHoldsMergeGrant` and its test were removed with the exception: nothing else read it.
- Open Inspector findings and unresolved threads from an earlier GitHub round still block a local
  head. Every other gate stays as it was.
- Trust explains the review a merge relies on in the YOLO merges column's description
  (`mergeGrantTitle`), naming the local review only while Local review is on. The Inspector's
  Local review card drops the merge-grant sentence and says Live may merge a locally reviewed
  head and Dry run merges nothing.

### Verification surfaces

- The fake `gh` gained an opt-in `mergeGate` (check rollup and mergeability on the Inspector's
  read) and the merge endpoint, a compare-and-swap on the head, so the end-to-end spec drives a
  real YOLO merge of a locally reviewed head.
- The merge queue's `local-review-missing` copy is read from a seeded row in the end-to-end spec;
  the daemon producing that verdict is covered by the worker tests, because the GitHub review that
  replaces the record lands one sweep later.
