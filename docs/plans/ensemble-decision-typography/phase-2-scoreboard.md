# Phase 2: The Scoreboard

Source plan: [`plan.md`](plan.md) section 3.3.
Index: [`phased-plan.md`](phased-plan.md).

## 1. Outcome

Best-of-N's decision surface stops being three independent essays side by side and becomes a comparison grid: rows are criteria, columns are candidates. Comparing the three candidates' risks becomes a horizontal glance instead of a ~1900px scroll.

The signature is the **margin ruler**: one 0-100 axis under the header plotting all three scores as ticks, so the margin of victory is a spatial fact. Today `score 92/100` in 12px grey hides whether the win was decisive or a coin flip, which is exactly the thing that decides whether to accept the recommendation or override it.

## 2. Entry criteria and dependencies

- Direct phase dependency: **Phase 1** (`phase-1-prose-scale-and-bounds.md`), merged.
- Why: criteria rows only align if no cell can grow without limit. Phase 1 owns the clamp; this phase consumes it.

## 3. Scope and non-goals

In scope:

- Transpose the Best-of-N result into a criteria-row grid.
- The margin ruler.
- An `Elapsed` criteria row (new information, see findings).
- `Recommended` as a badge in a fixed-height slot so the winning column aligns with its peers.
- A responsive fallback that does not produce horizontal page scroll.

Non-goals, explicitly:

- **Panel vote and Consensus keep their current presentation.** See the contract in section 4.
- **No label resolution**, no tone-cascade fix, no event log work (Phase 3 owns that).
- No server, schema, or wire change.
- Do not delete or repurpose `CandidateColumn`.

## 4. Repository findings and inherited contracts

**Measured problem.** At 1440x900, offsets from each card's own top:

| Section | Cand 1 | Cand 2 | Cand 3 | Spread |
| --- | --- | --- | --- | --- |
| Score line | +71 | +71 | +44 | 27px |
| Observed by Mission Control | +2160 | +1286 | +309 | 1851px |
| Strengths | +2365 | +1453 | +514 | 1851px |
| Risks | +2603 | +1691 | +676 | 1927px |

Cause: `.dossier-cols` is `repeat(auto-fit, minmax(min(320px, 100%), 1fr))` with `align-items: start`. Three independent flows, no shared rows.

**The sharing constraint - read this before designing.** `src/web/ensembles/results/dossier.tsx` exports `CandidateColumn`, and it is imported by **both**:

- `src/web/ensembles/results/BestOfN.tsx`
- `src/web/ensembles/results/PanelVote.tsx` (which also imports `AtStake`, `DecisionRecord`, `DissentLines`, `RankMatrix`, `RationaleText`, `recordedDecision`)

`Consensus.tsx` uses neither `CandidateColumn` nor the scorecard classes, so it is unaffected.

Transposing Best-of-N therefore must not rewrite `CandidateColumn` in place, or Panel vote's presentation changes with it - outside this plan's approved scope.

**The contract this phase must honour:** *presentation may diverge, data shaping may not.* Extract the per-candidate criteria values (score, confidence, diffstat, elapsed, strengths, risks, claim, recommended flag) into one shared helper that both presentations consume. Add the Scoreboard as a new presentation for Best-of-N; leave `CandidateColumn` serving Panel vote. Two renderers over one shaping function is acceptable. Two independent derivations of "what a candidate's numbers are" is a second source of truth and is not.

**Data availability - confirmed, no wire change needed:**

- **Diffstat** is already client-side and already rendered: `dossier.tsx:191` reads `observed.filesChanged / insertions / deletions`, typed at `src/web/ensembles/types.ts:72`.
- **Elapsed** is derivable from attempt `startedAt` / `finishedAt`, present in the shared types (`src/shared/ensemble.ts`, around lines 955-956 and 996-997) and returned by the ensemble detail route.

Elapsed is genuinely new information on this screen. On the reference run it was 49m / 5h 24m / 4h 38m - the winner was roughly six times faster than its rivals, and nothing on the decision screen says so today. Verify the field names against the current types before relying on them.

**Repo convention.** Tests assert "every class X renders has a rule in the stylesheet" (`test/panel-vote-render.test.ts:311` and others). Every new Scoreboard class needs a rule and should get the same coverage assertion.

**Palette constraint.** No new colour. Dark-only, the existing six state hues, `color-mix` off existing tokens, no web fonts. The mockup in `plan.html` uses only `--idle`, `--danger`, `--muted`, `--dim`, `--border*`, `--panel*`, `--mono`.

## 5. Implementation steps

1. **Extract the shaping helper.** Add a function that maps a `CandidateVerdict` plus its member/attempt/artifact records to the criteria values. Put it beside the existing verdict types in `dossier.tsx` or a sibling module - whichever keeps `PanelVote`'s import surface stable. Include an `elapsedMs` derivation that returns null when `finishedAt` is null, and never renders a fabricated duration.
2. **Build the Scoreboard renderer.** A CSS grid with a leading criteria-label column and one column per candidate. Every criterion is one grid row, so peer cells share a row box and align by construction. Reference the mockup in `plan.html` for the intended result, not for its class names.
3. **The header row.** Rank, candidate name, agent/model/effort, then a fixed-height flag slot. `Recommended` goes in that slot as a badge. The slot keeps its height when empty, which is what stops the winning column shifting 27px out of alignment with its peers.
4. **The margin ruler.** A 0-100 axis with one tick per candidate at its score, the winner's tick emphasised, and a bracket spanning the gap between the top two labelled with the point difference. Compute the gap from real scores. With two candidates the bracket still works; with a tie it must not render a nonsense negative - handle that case explicitly.
5. **Criteria rows.** Score (large, `--mono`, `tabular-nums`, with a small `/100`), Confidence, Diff, Elapsed, Strengths, Risks, Claim. Strengths/Risks/Claim reuse Phase 1's clamp and expander - do not add a second clamp implementation.
6. **Recommended column emphasis.** A subtle tint plus an inset left rule. Use `box-shadow: inset` or a background, not a border, so it adds no layout box and cannot shift alignment.
7. **Responsive fallback.** Below the width where three criteria columns stop fitting, fall back to one candidate per row-group with criteria labels repeated. The page body must not scroll horizontally at 1024px or below. The topbar's container-query ladder (`styles.css` around 970) is the house precedent if a container query fits better than a media query.
8. **Keep the decision form.** `DecisionPanel` composition is unchanged; only the candidate presentation above it is replaced.

## 6. Data, API, migration

None. Entirely client-side rendering over data the detail route already returns. No server, schema, or wire change. If implementation reveals a needed field that is genuinely absent client-side, **stop and report it** rather than adding a route change inside this phase - "no wire change" is a load-bearing claim of the approved plan.

## 7. Tests and verification

- `test/ensemble-page-render.test.ts` - "Best-of-N scorecards render anonymously-ranked but de-anonymised to their member" (around line 524) will need updating to the new structure. Preserve what it is actually protecting: that ranking is anonymous but attribution is correct.
- `test/ensemble-dossier-render.test.ts` - several cases assert column composition, Restore placement beside losing columns, and the override warning. Keep every behaviour; update only the structural assertions.
- `test/panel-vote-render.test.ts` - **must pass untouched.** If it needs edits, `CandidateColumn` was changed when it should not have been.
- Add a class-vs-stylesheet coverage assertion for the Scoreboard's classes.
- Add a case asserting criteria rows align: peer cells for a criterion share a row.

Commands:

```sh
node --test --test-concurrency=2 --import tsx test/ensemble-page-render.test.ts
node --test --test-concurrency=2 --import tsx test/ensemble-dossier-render.test.ts
node --test --test-concurrency=2 --import tsx test/panel-vote-render.test.ts
npm run typecheck && npm run lint && npm test && npm run build
```

**Playwright spec required** (`e2e/`), covering the assertions in `plan.md` section 6: criteria rows align across all three columns, no cell exceeds its bound, the score is present and larger than the claim prose, the ruler renders a tick per candidate, and the page body does not scroll horizontally at 1024px. Select by role/label; never add `data-testid`.

**Visual verification is required, not optional.** The repo's standard is runtime or visual verification for UI changes, not diff inspection. Drive the built dashboard against a real completed run and confirm the alignment claim at more than one width.

## 8. Merge and exit criteria

- Every criterion renders as one row shared by all candidates; peer cells align.
- The recommended column aligns with its peers (no 27px offset).
- The ruler shows each score and the gap between the top two.
- Elapsed renders per candidate, and renders honestly when unknown.
- Panel vote and Consensus are visually unchanged.
- No horizontal page scroll at 1024px.
- Typecheck, lint, unit tests, build, and the e2e spec pass.

## 9. Downstream handoff

There is no phase after this one in the approved scope. For whoever picks up the deferred work:

- The criteria-shaping helper is the seam to extend if `Submission A/B/C` resolution is later added - it should carry the resolved label, and the Scoreboard header slot is where the chip belongs.
- The Scoreboard is Best-of-N only by deliberate contract. Applying it to Panel vote is a separate decision, not a cleanup.

## 10. Cross-phase audit record

- Reconciled against Phase 1: consumes Phase 1's clamp class and expander instead of defining its own; requires Phase 1 merged. No conflicting selector.
- Reconciled against Phase 3: disjoint files (`EnsembleTimeline.tsx` versus the results renderers) and disjoint stylesheet regions. Either merge order is safe.
- Ownership note: the "do not modify `CandidateColumn`" constraint is owned here rather than in Phase 1, because Phase 1 changes only shared prose classes that Panel vote should inherit, whereas this phase is the one tempted to rewrite the component.
