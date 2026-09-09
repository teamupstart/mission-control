# Phase 2: Evidence pane with image thumbnails and preview

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)

## Outcome

Image evidence and Evidence readiness stop being two sections and become one Evidence pane. Frozen
images become visible where they matter: a thumbnail strip above the claims, and a small copy of the
image on every claim row that cites it, so a screenshot sits beside the claim it proves. Clicking a
thumbnail opens it full size in a modal.

This is the part of the work that adds a surface rather than rewriting one. Today an image is only
reachable by scrolling past the deliveries into a section of its own, and its link to a claim is a
bare `clientItemId` the reader has to match by eye.

## Entry criteria and dependencies

**Depends on Phase 1.** Requires `RunRecordTabs`, the pane registry, the pane id tuple on the runs
route, `runRecordSummary`, and the ledger and stat-strip CSS. Start from a checkout where Phase 1 has
merged to the default branch.

## Scope

- An Evidence pane replacing both `SubmissionImageEvidence` and `SubmissionEvidenceReadiness`.
- A gap block naming any canonical criterion the reconciliation could not match.
- A thumbnail strip for frozen images, and thumbnails on citing claim rows.
- A preview modal for a frozen image, with a footer carrying the metadata and the re-stage action.
- Lazy loading keyed off pane visibility.

## Non-goals

- The Inspector gate and the Foreman completion claim. Phase 3.
- Any change to how evidence is staged, frozen, reconciled or pruned. This phase renders records that
  already arrive; nothing in `src/server/` changes.
- Any change to readiness policy or to what the override records.

## Repository findings

- `SubmissionImageEvidence` is `WorkflowRuns.tsx:218-303` and `SubmissionEvidenceReadiness` is
  `:306-440`. Both are rendered from the run view at `:2745` and `:2752`.
- `LazyWorkflowEvidenceImage` (`:152-217`) already does the right thing: an `IntersectionObserver`
  with a 240px root margin sets `load`, then a fetch of
  `/api/workflow-runs/:runId/images/:imageId` produces a blob object URL that is revoked on unmount,
  with a `pruned` arm and an error arm. **The observer keys off scroll intersection.** A pane that is
  not selected is not scrolled past, it is not rendered, so the trigger has to become "this pane
  became visible". Keep the fetch, the revoke and both arms; change only what starts them.
- **The two claim lists are not duplicates, and merging them would lose information.** On run
  `2a8b89dc` round 2 every author claim matched a canonical criterion, so the lists agree and read as
  duplicates. On the four-image submission in the mockups (`c608ddc9` round 1) five of the six
  canonical criteria have `matchedClientCriterionId: null` and carry `missing_coverage` or
  `ambiguous_mapping`. A gap belongs to a canonical criterion that by definition has no author claim
  to sit under. The reconciliation therefore keeps its own block; it is not folded into the claim
  rows.
- **Match claims to reconciliation by id, not by text.** A claim row's status comes from the
  readiness criterion whose `matchedClientCriterionId` equals the claim's `clientCriterionId`.
  Matching on the criterion string works only when the author's wording and the canonical wording
  happen to be identical, which is exactly the case that has no gaps to show.
- **The image-to-claim relation is already in the record.** A coverage claim's `links` carry
  `{ clientItemId, role }`, and an image's client item id appears there with roles such as
  `rendered_output` and `state_snapshot`. On the mockup submission one image is cited by three
  claims. A card can say "cited by 3 claims as rendered output" instead of printing an id.
- **The preview has a model to copy.** `AttachmentPreview` in `src/web/components/ImageDrop.tsx:415`
  is the dispatch modal's own preview: `Overlay` with `OVERLAY_IDS.attachmentPreview`,
  `className="modal attach-preview"`, `role="dialog"`, `ariaModal`, a `.modal-head` with an
  `autoFocus` close button, and `.modal-body attach-preview-body` whose own `--bg` backdrop keeps a
  dark screenshot's edges visible. `AttachmentStrip:294` captures a focus bookmark on open and
  restores it on close.
- **The gesture deliberately differs.** `AttachmentStrip` opens on `onDoubleClick` and only opens on
  `onClick` when `e.detail === 0`, because a single click there would land the second click of a
  double on the backdrop that just appeared. That reasoning does not transfer: an evidence thumbnail
  has no competing single-click gesture. Open on a single click, and keep the `detail === 0` route so
  Enter and Space work. Record the difference in a comment where the handler lives; the two surfaces
  disagreeing on purpose is worth a sentence.
- `OVERLAY_IDS` in `src/web/components/Overlay.tsx:41` is a closed record. A new preview needs its
  own id so the Escape registry hands the key to the topmost layer.
- Existing coverage to update: `e2e/specs/workflow-image-evidence.spec.ts` (377 lines) and
  `e2e/specs/workflow-evidence-readiness.spec.ts` (863 lines), plus
  `e2e/specs/workflow-test-evidence-readiness.spec.ts`.

## Implementation steps

1. **Add the pane id.** Add `evidence` to the pane id tuple in `useWorkflowRoute.ts`. Nothing else in
   the route changes.

2. **Extend `runRecordSummary`.** Add the evidence facts: readiness status, author claim count, gap
   count, warning count, image count, and whether the run is parked on a readiness block. The pane's
   `blocking` flag is true when the readiness block has parked the run or a gap exists, not when a
   warning exists.

3. **Build the Evidence pane** as one component replacing both existing ones. Order: the stat strip,
   the "structural only" sentence, the gap block, the image strip, the claim rows, and the
   reconciliation disclosure. Preserve the readiness `unavailable` arm and its `role="alert"`.

4. **The gap block.** Render only when at least one canonical criterion has a gap. One row per such
   criterion with its gap codes as a chip. State in the copy that these are canonical criteria rather
   than author claims, so a reader is not left looking for a claim that does not exist.

5. **The image strip.** One card per frozen image: the thumbnail in a fixed frame, the display name,
   the client item id, the scope, the formatted size, and who cites it derived from the coverage
   links and grouped by role. A pruned image keeps its card and renders the existing "Body pruned"
   arm rather than a broken thumbnail; a load error keeps the existing error arm. The whole card is
   the control that opens the preview, as a real `<button>` with an accessible name of
   `Preview <display name>`. Render the strip's empty state when the submission froze no images.

6. **Thumbnails on claim rows.** A claim row whose links include an image renders a small copy of
   each cited image at the end of the row, with the image's display name as its title. These are
   decorative next to text that already names the claim; give them empty `alt`.

7. **Lazy loading.** Move the trigger from scroll intersection to pane visibility, keeping the
   observer for the case where a long strip is below the fold within a visible pane. The fetch, the
   object URL and its revoke are unchanged. One object URL per image, shared by the strip card, the
   claim-row copies and the preview, so opening a preview costs no second request.

8. **The preview modal.** Add an `OVERLAY_IDS` entry and build the component on `AttachmentPreview`'s
   shape: `Overlay`, `.modal attach-preview` plus a class of its own, `.modal-head` with the display
   name and an `autoFocus` close control, `.modal-body attach-preview-body` with the image. Add a
   `.modal-foot` carrying the caption, item id, scope, MIME type, size, availability and full
   SHA-256, plus the "Use in next review" re-stage button with its existing handler, disabled and
   busy states and its "Ready for next review" settled label. Capture the focus bookmark on open and
   restore it on close. Escape closes this layer only.

9. **Preserve every readiness control.** The "Continue despite gaps" region with its reason textarea,
   its `WORKFLOW_LIMITS.readinessOverrideReason` cap, its acknowledgement checkbox, the
   refinements-exhausted notice, the recorded override sentence and the retry button all move into
   the pane unchanged.

10. **CSS.** Strip, card, frame, mini thumbnail, gap block and preview footer rules. The preview
    renders into a modal, so it must not re-declare a horizontal inset: `.modal` supplies
    `--modal-inset`, and `.modal-head`, `.modal-body` and `.modal-foot` already carry `.modal-bleed`
    behaviour. Add no padding-inline to anything inside it.

## Tests and verification

- `node:test` for the claim-to-reconciliation match by `matchedClientCriterionId`, including the case
  where no criterion matches and the case where wordings differ.
- `node:test` for the cited-by derivation: grouping by role, the zero-citation case, and an image
  cited by several claims.
- `renderToStaticMarkup` cases for the stat strip counts, the gap block, an image card's facts, a
  pruned image's card, and a claim row carrying a thumbnail.
- A new Playwright spec: a submission with frozen images shows a thumbnail in the Evidence pane;
  clicking it opens the preview; the preview carries the caption and the digest; Escape closes only
  the preview; focus returns to the thumbnail; a claim that cites an image shows a copy of it.
  Call `expectContentClearsBorder` from `e2e/fixtures/modal-inset.ts` on the preview. Image bodies
  come from a fixture; never fetch a real run and never spend model tokens.
- Update `e2e/specs/workflow-image-evidence.spec.ts`,
  `e2e/specs/workflow-evidence-readiness.spec.ts` and
  `e2e/specs/workflow-test-evidence-readiness.spec.ts` to reach the pane instead of the removed
  sections. Keep every behavioural assertion they make; only the route to the element changes.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- The Evidence tab renders readiness, coverage, reconciliation and images in one pane, and the two
  old sections are gone.
- A frozen image is visible as a thumbnail without opening anything, and opens full size on a click.
- Every field the image ledger carried today is present in the preview footer.
- Readiness retry, override and re-stage all still reach their routes with their confirms intact.
- A submission with no images renders an empty state rather than an empty strip.
- All verification above passes.

## Downstream handoff

Phase 3 may rely on: the pane id tuple now containing `evidence`, the extended `runRecordSummary`,
and the strip, card and mini-thumbnail CSS if it needs a thumbnail. It must not change the preview
overlay's id, the pane order, or the `blocking` semantics.

## Cross-phase audit record

- Reconciled against Phase 1. Two contracts were pushed back into Phase 1 rather than being handled
  here: the pane registry's null-render rule, and `runRecordSummary` as the single place counts are
  computed. Extending the summary rather than counting in this pane is what keeps the tab label and
  the pane body from ever disagreeing.
- Reconciled against Phase 3. Phase 3 reuses this phase's ledger table and row classes and adds no
  new families. The Inspector gate does not carry images, so nothing here is a prerequisite for it
  beyond the shared file.
