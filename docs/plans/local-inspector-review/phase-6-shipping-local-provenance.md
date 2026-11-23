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
   appended reason for a missing local review.
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
- A push after the local pass changes the head, so the recorded posture no longer applies and
  the head needs a GitHub review, as any "other head" does.

## 7. Tests and verification

- Predicate tests in `test/shipping-merge.test.ts`: a matched local head merges once the other
  gates pass; an unreviewed, amended or later-pushed head is refused; `localReview` off
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
