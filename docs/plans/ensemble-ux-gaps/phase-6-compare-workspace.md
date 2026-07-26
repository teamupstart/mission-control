# Phase 6 - Compare workspace: file-touch matrix and synchronized diff panes

## 1. Outcome and value

Candidates become comparable side by side. A Compare section in the run detail lets the operator pick 2-3 ready artifacts and see: a file-touch matrix (rows = union of changed files, columns = candidates, cells = churn, "only #N" marks), synchronized per-file diff panes fed by the Phase 2 `?path=` route, and a claims strip per column (reported summary, checks, frozen cost, and score/rank/confidence once the review lands). Scorecard rationale that names a path present in the union links to that matrix row. Closes G14, G15, and the remainder of G16.

## 2. Entry criteria and dependencies

- Direct prerequisites: Phase 2 (`?path=`, `?filesOnly=1`, `patchPaths`) and Phase 5 (detail-page structure and threaded props settled). Phase 2 may have merged long before; only its contract is consumed.

## 3. Scope and non-goals

In scope: the Compare section, its fetch layer, matrix + panes + claims strip, rationale file-anchors, API client additions, tests, docs. Non-goals: diff-of-diffs or three-way merge views; comparing non-`commit` artifact kinds (only adapter today); any server change beyond what Phase 2 shipped; persisting the operator's selection (component state only).

## 4. Repository findings this phase is built on (verified 2026-07-26)

- Phase 2 contract: single `?path=` per request (multi-path deliberately refused - 16KB header precedent at `routes.ts:1113-1117`); `?filesOnly=1` returns complete `files` with no patch; `patchPaths` distinguishes a cut from the whole; `files` is complete in every response ("stats always complete, only the patch is capped", `ensemble-snapshot.ts:229-231`).
- The client fetch layer: `src/web/lib/api.ts:214-316` holds the ensemble calls; `EnsembleArtifacts.tsx` fetches patches lazily once per open row - the Compare section adds its own fetches and must not disturb that row cache.
- Evidence seam: `onOpenArtifact -> openArtifactId -> autoOpen` (`EnsembleDetail.tsx:236, :270`) stays for whole-artifact evidence; the Compare section is a sibling of Artifacts, mounted between Members and Artifacts.
- Scorecards and claims come from the dossier pieces (Phase 4: `CandidateColumn` composition inputs) and `artifact.metadata.reported` / `.observed` / `agentCostUsd`; subject labels via the existing `subjectLabel` memo (`EnsembleDetail.tsx:72-103` - never hard-code "Candidate").
- Byte bounds: per-file patches ride the same `maxBytes` ceiling (default 400 KiB, max 4 MiB, `boundedLimit` at `routes.ts:388`); truncation is disclosed via `truncated`/`omittedBytes` and the pane must render the disclosure, matching the honesty rule everywhere else in the feature.

## 5. Implementation steps

1. **API client** (`src/web/lib/api.ts`): `fetchArtifactFiles(runId, artifactId)` (uses `?filesOnly=1`) and `fetchArtifactFilePatch(runId, artifactId, path, maxBytes?)` (uses `?path=`).
2. **Selection model** - `src/web/ensembles/compare.ts` (pure): given the detail, the ready `commit` artifacts eligible for compare; selection capped at 3; the file union with per-artifact stats (`buildFileMatrix(filesByArtifact)` returning rows sorted by total churn, each cell `{ins, del, renamedFrom?, binary?}` or absent, and an `onlyIn` mark when exactly one column touches the row).
3. **`EnsembleCompare.tsx`** - the section component: artifact picker (checkbox per ready artifact, labeled by `subjectLabel`); on selection, `filesOnly` fetches fan out (one per artifact, cached per artifact id); the matrix table renders from `buildFileMatrix`; clicking a row loads that path's patch per selected artifact (parallel `?path=` fetches, cached per artifact+path) into side-by-side `<pre>` panes with a shared sticky file header and per-pane truncation disclosure; the claims strip renders above the panes (one column per artifact: reported summary first line, checks count, cost with unknown-not-zero, and score/rank/confidence when an evaluation covers it).
4. **Rationale anchors** - in the dossier/scorecard rendering (Phase 4 pieces), detect repo-relative paths in rationale text that appear in the compare union (exact-token match only, no fuzzy guessing) and render them as buttons that select that artifact pair and open that matrix row. Pure helper in `compare.ts` with tests; when the Compare section has no selection yet, the anchor seeds it with the scored artifact plus the recommended one.
5. **Layout + CSS** - panes are a horizontal grid inside the section with per-pane horizontal scroll (the page body never scrolls sideways); new `ensemble-compare-*` rules in the ensembles CSS section.
6. **State care** - selection and caches are component state, reset when the run id changes; the section renders only when >= 2 ready `commit` artifacts exist, else a one-line explanation ("comparison opens when two snapshots are ready").

## 6. Data / compatibility

No server changes (Phase 2's contract consumed as-is). `EnsembleResultContext` untouched; the anchor helper is imported by the result pieces, not injected. Renderer registry untouched (Compare is strategy-neutral machinery - it reads artifacts and evaluations generically).

## 7. Tests and verification

- New `test/ensemble-compare.test.ts` (comment: what is at stake is honest side-by-side evidence): `buildFileMatrix` union/ordering/only-in marks/rename cells; selection cap; anchor detection is exact-token (a rationale naming a non-existent path yields no anchor); claims strip preserves unknown-vs-zero cost.
- Render test: matrix from three stub artifacts; opening a row renders panes with truncation disclosure when `truncated`; empty state under 2 ready artifacts.
- Extend the api-client test coverage if a pattern exists for `lib/api.ts`; otherwise the render test drives fetches through a stubbed fetch.
- Commands: `npm run typecheck`, `npm test`; manual: a real run with 3 candidates - matrix, row open, anchors from a scorecard, and the Artifacts section's own rows still working.

## 8. Merge and exit criteria

Suite green; `docs/ensembles.md` gains the Compare section (including the >= 2 gate and the single-path fetch rule); README ensemble paragraph updated. The final state of the six phases matches the approved plan: every gap OWNED by a phase is shipped - G1-G4, G6-G8, G11-G18, and the badge half of G5 - while the recorded out-of-scope remainder stays open and stays recorded (G5's feature-home relocation, G9's stall timer policy, G10, G19, G20; see the index's out-of-scope section).

## 9. Downstream handoff

None planned beyond this phase. Future strategy work may rely on: Compare being strategy-neutral (it must stay free of strategy branches); the anchor helper's exact-token contract; the per-artifact/per-path client caches being component-scoped.

## 10. Cross-phase audit record

- 2026-07-26 (round 3): exit criteria narrowed from "every gap group G1-G18" to the phase-owned set after PR #263's Inspector noted the blanket claim contradicted the index's own out-of-scope list (G5's home relocation, G9's timer, G10, G19, G20); the index's out-of-scope section and final verification paragraph updated in lockstep.
- 2026-07-26: initial version. Reconciliations: (a) `filesOnly` moved into Phase 2 after this phase's matrix design showed N full-patch fetches otherwise; (b) the approved decision "matrix PLUS synchronized panes" is honored - the reduced matrix-only scope offered during review was declined; (c) panes fetch per file per artifact (never multi-path) per Phase 2's recorded header-size rule.
