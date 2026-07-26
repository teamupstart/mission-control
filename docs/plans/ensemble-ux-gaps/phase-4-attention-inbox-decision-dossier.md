# Phase 4 - Attention inbox and decision dossier

## 1. Outcome and value

The two moments the operator must act on get purpose-built surfaces. The topbar's reviews chip generalizes into one attention inbox: every item that needs the human (session reviews with their ensemble context, ensemble decision requests, parked finalizations, gate decisions), answerable inline or one click from its home. At `awaiting_decision`, the run detail leads with a decision dossier: what was at stake, one column per candidate composing claims + observed stats + cost + score, a judge-reasoning band (rank matrix, surfaced dissent), and the hoisted decision form - persisting read-only after the decision with Restore beside losing columns. Closes G4, G12/G13 (inbox), G14 partially, G16, G17, G18 (dossier).

## 2. Entry criteria and dependencies

- Direct prerequisites: Phase 1 (`membersNeedingInput` for inbox items and dossier header), Phase 3 (shared `EnsembleProgressDots`; the ceded topbar surface; both phases edit `App.tsx` and `session-bits.tsx`, so ordering avoids conflicting merges).

## 3. Scope and non-goals

In scope: the inbox overlay, the `openReviews` replacement, `ReviewCard` export, the dossier restructure of the Result section, the decision-form hoist, rank matrix + dissent for panel vote, tests, README, docs. Non-goals: live member-session state inside the detail (Phase 5 threads sessions/reviews into the detail; at decision time members are settled, so the dossier needs neither); pane-dialog answering in the inbox (a pane dialog is a transient TUI fact answered on the card - the inbox lists it as a deep-link item only, see 5.1); any new notifier (the inbox is a rendering of existing state, never a second alert engine).

## 4. Repository findings this phase is built on (verified 2026-07-26)

- The chip today opens the FIRST answerable review's session modal (`App.tsx:679-682`, chip at `:1291-1299`); `answerableReviews` (`App.tsx:583-586`) filters pending reviews to live sessions, deliberately narrower than `pendingReviews` (comment `:572-582`).
- All inbox inputs are already in App's render scope: `answerableReviews`, `ensembleSummaries` (each with `attention`, and after Phase 1 `membersNeedingInput`), `gateAlerts` (`App.tsx:528-531`), `stalls`, `scheduleAttentionCount`. `AlertScope` excludes reviews and `useNotifier` produces OS notifications only - the inbox folds at App level and must NOT reuse `detectAlerts`.
- Overlays: one `OVERLAY_IDS` entry (`Overlay.tsx:41-57`) + rendering through `<Overlay>`; registration is automatic and `overlay-registry.test.ts` enforces routing through the primitive. Rendering as a modal inherits `.modal-backdrop`, already in the `.is-desktop` no-drag list - a chip-anchored floating popover would instead trip `desktop-drag-region.test.ts`, so the inbox is a modal.
- `ReviewCard` (`ReviewModal.tsx:61`) is session-agnostic (only `api.resolveReview`) but NOT exported - export it. The `namePrefix={review.id}` uniqueness rule (`ReviewModal.tsx:127-130`) is mandatory when many sessions' decision forms share one document.
- The dossier's data is all in the fetched detail: members, artifacts (with `metadata.reported` claims, `observed` stats, `agentCostUsd`), evaluations, decisions. `EnsembleRun.intent` is persisted on the run row (verify exact field name against `EnsembleRun` when implementing; the create input requires `intent`).
- Detail section order today: header, facts, **Result**, Outcome, Members, Artifacts, Timeline, Actions (`EnsembleDetail.tsx:145-288`); `decision` context built at `:117-136`; Evidence flows `onOpenArtifact -> openArtifactId -> EnsembleArtifacts autoOpen` (`:236`, `:270`).
- The decision form is duplicated near-verbatim between `BestOfN.tsx:134-262` and `PanelVote.tsx` (~250-340) - the hoist target. PanelVote's `entry.ranks` (rendered at `:158-165`) already carries the full judge x candidate rank record - the matrix is a re-projection, no new wire. Ballot selection must follow `ballots(detail)` (`PanelVote.tsx:30-40`, latest `driverKind === "review"` stage attempt), not "newest succeeded evaluation".
- Renderer contract (`results/index.ts:17-45`): context is `{ detail, subjectLabel, onOpenArtifact, decision }` - the dossier stays inside the renderers plus shared pieces, honoring "a new strategy adds a renderer here and nothing else".

## 5. Implementation steps

### 5.1 Attention inbox

1. Add `OVERLAY_IDS.attention`; new `src/web/components/AttentionInbox.tsx` rendering `<Overlay id={OVERLAY_IDS.attention} className="modal">`.
2. Item fold (pure function, unit-testable, in `src/web/lib/attention.ts`): sections in fixed order - (a) ensemble decisions (`status === "awaiting_decision"`), one item per run with title, strategy, `EnsembleProgressDots`, "Open dossier" (deep link `#/workflows/ensembles/:id`); (b) session reviews from `answerableReviews`, grouped by session, each rendered with the exported `ReviewCard` (unique `namePrefix` kept) under a header line carrying `AgentDot`, session name, and - when `session.task.ensemble` exists - the run context sentence ("Best of N 'title' - candidate 3 of 5"), closing G13; (c) blocked-member dialog items (sessions with `paneDialog` whose task has an ensemble link) as deep-link rows to the session (answered on the card - two wire protocols are not unified here, recorded deliberately); (d) parked finalizations (`status === "finalizing" && error`) and gate sessions (`gateAlerts`) as deep-link rows.
3. Replace `openReviews` (`App.tsx:679-682`): the chip opens the inbox; its count becomes the fold's total; label "N need you". Per-session entry points to `ReviewModal` (card affordance, board tile flag) are unchanged.
4. CSS: a new `/* ---- attention inbox ---- */` section; modal chrome reused.

### 5.2 Decision dossier

1. Hoist the duplicated decision form into `src/web/ensembles/results/DecisionPanel.tsx` (radio choices supplied by the caller, no-consensus arm, rationale, destructive confirm, override warning); BestOfN and PanelVote consume it; Consensus keeps its divergence form.
2. New shared dossier pieces in `src/web/ensembles/results/dossier.tsx`: `AtStake` header (run intent, base sha, elapsed, aggregate candidate cost via `aggregateEnsembleAgentCost` with unknowns preserved); `CandidateColumn` (subject label, reported summary + checks, observed diffstat, cost, score/rank/confidence when scored, strengths/risks, Evidence via the existing `onOpenArtifact` seam); `RankMatrix` (judges x candidates from `entry.ranks`, contested cells marked); `DissentLine` (for each judge whose rank of the aggregate winner is worst, quote that ballot's rationale for the winner's card).
3. Recompose `BestOfNResult` and `PanelVoteResult` around these pieces when `ctx.decision != null` OR the run is terminal with a recorded decision (the read-only record): AtStake, columns (BestOfN: one evaluator, matrix degenerates away; PanelVote: matrix + dissent above the collapsible ballots, which remain), then `DecisionPanel` (or, terminal, the recorded selection + rationale + per-losing-column Restore buttons wired to the existing `restore_artifact` action threaded through a new optional `onRestoreArtifact` context field).
4. Extend `EnsembleResultContext` additively: `onRestoreArtifact?: (artifactId: string) => void`; `EnsembleDetail` supplies it from its existing action plumbing.
5. Result section stays where it is in the section order; the dossier is its content, so Evidence -> Artifacts scrolling keeps working via the untouched `openArtifactId` seam.

## 6. Data / compatibility

No wire changes. `EnsembleResultContext` gains one optional field (additive; extension-contract comment in `results/index.ts` updated). `ReviewCard` export is a one-line visibility change.

## 7. Tests and verification

- New `test/attention-inbox.test.ts` (comment: what is at stake is one place to drain everything that needs the human): the fold's sections and ordering; ensemble review items carry the run-context sentence; counts match the chip; unique `namePrefix` per rendered decision form; a dismissed-session review disappears (live-session filter preserved).
- `overlay-registry.test.ts` passes with the new id (auto-scanned); `desktop-drag-region.test.ts` untouched (modal path).
- New `test/ensemble-dossier-render.test.ts`: AtStake renders intent/cost with unknown-not-zero; rank matrix cells match `entry.ranks`; dissent line quotes the right ballot; terminal run renders read-only record with Restore per losing column; recommended-override warning still present via `DecisionPanel`.
- Update any snapshot in `ensemble-page-render` touching Result.
- Commands: `npm run typecheck`, `npm test`; manual: drive a run to `awaiting_decision`, answer from the inbox, decide from the dossier.

## 8. Merge and exit criteria

Suite green; README keyboard/overlay notes updated (the chip's new behavior); `docs/ensembles.md` decision section rewritten around the dossier and the inbox (including the deliberate non-unification of pane dialogs). The one-shot decision semantics (`expectedStatus`) are unchanged and restated in the dossier's read-only copy.

## 9. Downstream handoff

Later phases may rely on: `OVERLAY_IDS.attention` and the fold in `lib/attention.ts` as THE topbar attention surface; the exported `ReviewCard`; `DecisionPanel` and the dossier pieces as the one decision rendering; `onRestoreArtifact` on the renderer context. They must not: add a second topbar attention entry, render a decision form outside `DecisionPanel`, or unify pane-dialog answering into the inbox without revisiting the 5.1(c) decision.

## 10. Cross-phase audit record

- 2026-07-26: initial version. Reconciliations: (a) source plan's Solution C "run strip on member cards" is dropped - Phase 3's clustering and enriched marks subsume it; (b) the inbox is a modal, not a chip-anchored popover, because of the drag-region scan; (c) pane dialogs are deep-linked, not answered inline in the inbox - reviews and pane dialogs are two wire protocols and the inbox renders only the one that is session-agnostic today; (d) the dossier lives inside the existing Result renderers rather than a new page, honoring the renderer registry as the one strategy-keyed surface.
