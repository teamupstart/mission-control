# Phase 3: Evidence carry-forward and digest deduplication

## Outcome and value

Sufficient evidence collected in one round stays available in the next. A preflight refinement child
inherits its parent's frozen evidence and coverage wholesale, so a mapping repair can never lose a
screenshot it did not touch (the round-1 screenshot vanishing at submissions 2.0/2.1 cost a full
Persona round on the observed run). Registering byte-identical evidence reuses the frozen blob
instead of copying it (41.6% of all registrations in the live database were duplicates; one
38,600-byte screenshot was registered nine times), and agents stop minting fresh id prefixes every
round to dodge "already reserved". Evidence carried across Persona repair rounds is marked with its
origin so reviewers can judge staleness honestly.

## Entry criteria and dependencies

- Direct dependency: **Phase 1** (run intent snapshot). Inherited coverage maps onto canonical
  criteria; Phase 1 makes those criteria stable for the run, so inherited claims stay meaningful.
  Phase 1 also reworks the same capture region of `manager.ts` this phase extends.
- Anchors verified at commit `4e0b70e7`; re-verify against Phase 1's merged state before starting.
  Line numbers below also predate `main` at `c6e64be9` (`store.ts` +38, `manager.ts` +67 before
  Phase 1's own edits); every named symbol is intact. PR #952's run lifecycle model does not touch
  this phase - it constrains the `status`/`current_phase`/`gate_state_json` triple, and nothing
  here writes one - but if step 5 or 6 ends up parking a run under a new reason, that reason is now
  a registered `WorkflowRunPhase`; see Phase 2's step 3.

## Scope and non-goals

In scope:

- Wholesale evidence and coverage inheritance for `evidence_preflight` refinement children.
- Digest-based deduplication at registration and freeze time.
- Re-staging semantics that let an unchanged item attach to a new submission.
- Inherit-and-mark metadata (origin round, capture repository fingerprint) across Persona repair
  rounds, rendered in the Persona evidence manifests.

Non-goals:

- No auto-expiry by diff-path intersection (explicitly dropped in the source plan's decisions).
- No weakening of the unchanged-evidence refusal: it compares repository fingerprints
  (`src/server/workflows/manager.ts:6194-6196`) and must keep firing when a whole tree is
  resubmitted unchanged.
- No changes to intent, criteria, or compaction (Phase 1 owns those contracts).
- No changes to the Persona prompt's coverage disclaimer (Phase 2).

## Repository findings

- Staging upsert: `src/server/workflows/store.ts:4605-4629`. A byte-identical re-stage short-circuits
  as a no-op (`same` check ending at `store.ts:4621`), leaving the row `reserved` and attached to
  the old submission; a changed re-stage under a reserved id throws "already reserved"
  (`store.ts:4623`). Coverage staging mirrors this at `store.ts:4630-4647`.
- Reservation selects only `state = 'staged'` rows (or rows already reserved to the same group key)
  and flips them one way to `reserved` (`store.ts:8930-8971`); coverage freezes into
  `workflow_submission_evidence_coverage` (`store.ts:8991-9004`). Nothing ever returns a row to
  `staged`, which is why every submission starts from an empty tray.
- Preflight refinement children carry `refinementReason: "evidence_preflight"` and a
  `parentSubmissionId` (provenance at `store.ts:1028-1066`); the manager's capture path branches on
  exactly this pair, which is where inheritance hooks in. **Phase 1 reshaped that branch.** It now
  reads `runRow.intent` and `runRow.criteria`, reuses the run's frozen criteria for every
  submission, and resolves the per-submission coverage bridge through `criterionBridge` - the
  parent for a refinement segment, the preceding snapshot otherwise. The preflight-only
  parent-reuse gate survives for pre-migration runs alone. Inheritance should hook into the
  submission's EVIDENCE, not that criteria branch: the two are now separate concerns in the same
  region.
- Frozen image and artifact rows live in `workflow_submission_images` and
  `workflow_submission_text_artifacts`; capture routes through `src/server/workflows/images.ts`.
  Staged rows already carry `sha256`, `bytes`, `source_locator`, and a repository scope; submissions
  carry `repository_fingerprint`.
- Persona manifests render image and artifact metadata (id, caption, displayName, bytes, sha256) in
  `src/server/workflows/prompt.ts:99-130`; inherited marks belong in these manifests.
- Aggregate limits are enforced both at staging (`store.ts:4663`) and reservation
  (`store.ts:8940-8954`); inherited items must count against the same limits.

## Implementation steps

1. **Preflight-child inheritance.** When creating or capturing an `evidence_preflight` refinement
   child, copy the parent submission's frozen evidence set (images, text artifacts) and coverage
   rows into the child, then apply the child's newly staged items and claims on top (new claims for
   a criterion replace inherited ones for that criterion; new evidence adds to the set within the
   existing aggregate limits). The tree did not change between parent and child by definition of the
   segment, so no staleness mark is needed here.
2. **Digest deduplication at freeze.** When freezing a staged item whose `sha256` already exists as
   a frozen blob for the same note, reference the existing blob rather than writing a second copy.
   Registration of an identical payload under a new client id becomes cheap by construction.
3. **Re-staging semantics.** Change the byte-identical no-op (`store.ts:4621`) so an item whose
   current row is `reserved` re-stages as a fresh `staged` row (deduplicated by digest) instead of
   silently staying attached to the old submission. Re-staging identical content under the same
   client id therefore attaches it to the next submission, and the "already reserved" throw remains
   only for genuinely changed content under a reserved id. This removes the reason agents mint
   per-round id prefixes.
4. **Inherit-and-mark across Persona rounds.** For a new root submission in round N+1, carry forward
   the previous submission's frozen evidence marked `inherited` with origin round and the repository
   fingerprint it was captured at. Verify each carried item's stored `sha256` against its
   `source_locator` where the locator still resolves; drop the item when the source has changed.
   Render the mark in the Persona manifests (`prompt.ts:99-130`) so a reviewer sees "captured at
   round N under fingerprint F" and judges staleness itself.
5. **Guard interaction.** Confirm by test that inheritance does not defeat the unchanged-evidence
   refusal: an unchanged tree resubmitted with inherited evidence still refuses via the repository
   fingerprint comparison at `manager.ts:6194`.
6. **Readiness interaction.** The preflight (`criterion_mapped_v1`) evaluates the child's effective
   evidence set including inherited items, so a mapping repair no longer reports
   `missing_coverage` for evidence that existed one segment earlier.
7. **Criteria stability is Phase 1's, not this phase's.** Inherited coverage maps onto the run's
   frozen canonical criteria; do not recompact, re-derive, or re-key them, and do not make
   inheritance depend on an intent fingerprint comparison - there is deliberately none on the
   run-level reuse path. If inherited claims need a wider bridge than `criterionBridge` supplies,
   widen the bridge rather than reopening compaction.

## Data and compatibility details

- New columns (for example `inherited_from_submission_id`, `origin_round`,
  `origin_repository_fingerprint` on frozen rows) follow the addColumn-in-migrate convention in
  `src/server/db.ts`. Existing frozen rows read as non-inherited.
- Blob reuse must keep deletion/cleanup correct: `workflow_image_cleanup` and eviction paths must
  not remove a blob still referenced by another submission. Reference-count or copy-on-last-reference
  semantics are the implementing agent's choice; record it in the PR.
- No renaming or reordering of persisted append-only IDs.

## Tests and verification

- `test/` unit coverage: preflight child inherits parent evidence and coverage (the round-1
  screenshot scenario reproduced and fixed); identical-digest registration reuses the frozen blob
  (assert stored byte totals); re-staging identical content after reservation attaches to the next
  submission; changed content under a reserved id still throws; inherited marks present with origin
  round and fingerprint; unchanged-tree resubmission still refused; cleanup never orphans or
  double-frees a shared blob.
- Persona manifest rendering covered by the existing prompt unit-test style
  (`renderToStaticMarkup` is not involved; prompt builders are plain functions).
- Commands: `npm run typecheck`, `npm run lint`, `npm test`; `npm run build` and `npm run smoke`
  because runtime storage surfaces change.

## Merge and exit criteria

- All listed tests pass; typecheck and lint green; no unrelated edits.
- On a simulated two-round run, round 2 starts with round 1's evidence available and marked, and a
  preflight refinement never loses evidence its parent held.
- One reviewable PR.

## Downstream handoff

Nothing currently depends on this phase. Future work (rendering full coverage to Personas, an
operator intent-amendment event) may rely on: the inherited-mark columns, the digest-reuse
invariant (one frozen blob per digest per note), and the preserved unchanged-evidence guard.

## Amendments

- **2026-09-09, operator decision during implementation.** "Wholesale" evidence inheritance is
  bounded by the aggregate evidence limits. Coverage inheritance is literal within the
  frozen-coverage limit: every parent claim is retained and only a link whose cited evidence is
  absent is dropped. That limit binds only when a parent already at `maxClaims` meets a child
  that declared claims of its own, because `listSubmissionCoverage` reads the table through a
  schema capped at `maxClaims`; exceeding it makes the submission's coverage unreadable rather
  than larger, and reaching it is recorded as `evidence_carry_truncated`. Evidence inheritance cannot
  be, because `WORKFLOW_IMAGE_LIMITS.maxCount` is `LLM_IMAGE_LIMITS.maxCount`, the number of images
  one model call accepts, enforced by `validateDescriptorSet`. The same counts cap the frozen
  arrays in `WorkflowContextSnapshotSchema`. Removing the budget was measured to fail the capture
  as `stale_capture` and lose every item; giving the parent absolute priority was measured to
  starve the child's repair evidence so the refinement can never succeed. The implemented rule is
  the best available split: the carry gives up the oldest ancestry first and never an item the
  previous submission captured itself, and records `evidence_carry_truncated` naming what it
  refused. Reached after five No-Mistakes repair rounds on this clause; see the source plan's
  matching amendment.

## Cross-phase audit record

- 2026-09-08 (Phase 1 implementation): Phase 1 landed and this phase's dependency is satisfied.
  The concrete inheritance points are unchanged - staging upsert, reservation, and the frozen
  image/artifact tables were untouched - but the capture region was reworked as described in
  Repository findings, and `reuseWorkflowContextCriteria` now takes a structural
  `WorkflowCriteriaSource` plus explicit source mappings. Step 7 was added to state the boundary
  the source plan already implied. PR #952 confirmed irrelevant to this phase.
- 2026-09-08: Initial version. Depends on Phase 1 for stable canonical criteria (inherited coverage
  claims map onto criteria that no longer drift) and to avoid concurrent rework of the
  `manager.ts:6026-6052` capture region. Phase 2's readiness disagreement signal reads
  `readiness_json` only and is unaffected by inheritance; the refinement cap counts segments, not
  evidence, so no conflict.
