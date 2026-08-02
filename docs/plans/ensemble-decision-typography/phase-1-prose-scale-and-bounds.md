# Phase 1: Prose type scale and bounded claims

Source plan: [`plan.md`](plan.md) sections 3.1 and 3.2.
Index: [`phased-plan.md`](phased-plan.md).

## 1. Outcome

Ensemble result prose stops rendering at the browser's default 16px with `line-height: normal`, and no single candidate's claim can set the height of the row it sits in.

Standalone value, before any layout work: today the three Best-of-N columns run 2806px / 1932px / 936px because the claim is unbounded. Clamping it collapses that spread inside the *existing* column layout, so this phase is worth merging even if Phase 2 never lands. It is also the foundation Phase 2 requires, because criteria rows cannot align if a cell can grow without limit.

## 2. Entry criteria and dependencies

- Direct phase dependencies: **none**. This is the foundation.
- Entry: `main` green.

## 3. Scope and non-goals

In scope:

- Declare `font-size` and `line-height` on the ensemble result prose classes so nothing inherits the UA default.
- Introduce a bounded-prose treatment (line clamp plus an explicit expander) for the candidate claim, and an item clamp for strengths and risks.
- Extend the affected render tests.

Non-goals, explicitly:

- **No layout transposition.** The `dossier-cols` three-column grid stays exactly as it is. Phase 2 owns that.
- **No label resolution.** `Submission A/B/C` stays unresolved; deferred by decision.
- **No tone-cascade fix.** The Members section keeps its status-coloured prose; deferred by decision.
- No server, schema, or wire change.

## 4. Repository findings

Measured on the live DOM of a completed three-candidate run at 1440x900:

| Selector | Computed size | Weight | Colour |
| --- | --- | --- | --- |
| `.ensemble-reported p` | 16px | 400 | `--fg` |
| `.ensemble-checks li` | 16px | 400 | `--fg` |
| `.ensemble-scorecard-cols li` | 16px | 400 | `--fg` |
| `.ensemble-score` | 12px | 400 | `--muted` |

`body` never declares a `font-size` in `src/web/styles.css`, so these resolve to the user-agent default. `line-height` computes to `normal` on all of them. 87% of `font-size` declarations in the stylesheet fall between 9px and 13px, so this subtree is the outlier.

Relevant CSS lives in `src/web/styles.css` around lines 8785-9026 (`.ensemble-scorecards`, `.ensemble-scorecard`, `.ensemble-scorecard-cols`, `.dossier-*`), with a responsive block near 9767. Verify these line numbers before editing; the file is ~19,400 lines and moves.

**Blast radius.** `src/web/ensembles/results/dossier.tsx` exports `CandidateColumn`, and **both** `BestOfN.tsx` and `PanelVote.tsx` import it. `Consensus.tsx` uses neither `CandidateColumn` nor the scorecard classes. So a change to the shared prose classes lands on Best-of-N and Panel vote together, and that is desirable here: both inherit the readable scale for free.

**Repo convention to honour.** Several tests assert "every class X renders has a rule in the stylesheet" (for example `test/panel-vote-render.test.ts:311`, `test/attention-inbox.test.ts:315`). Any new class introduced here needs a matching stylesheet rule, and should get the same coverage assertion.

## 5. Implementation steps

1. **Declare the scale.** In `src/web/styles.css`, add explicit `font-size: 12.5px; line-height: 1.55;` to the ensemble result prose: `.ensemble-reported` (and its `p`), `.ensemble-checks` (and its `li`), and `.ensemble-scorecard-cols` (and its `li`). Follow the file's convention of a short comment saying why the declaration exists - that the subtree otherwise inherits the UA default.
2. **Give figures tabular numerals.** Add `font-variant-numeric: tabular-nums` to `.ensemble-score` and the observed diffstat line, so digits align between candidates. `.dossier-cost` already has it; match that.
3. **Add the clamp.** Introduce a bounded-prose class (suggested `.ensemble-clamp`, with a `--clamp-lines` custom property defaulting to 3) using `-webkit-line-clamp` with `-webkit-box-orient: vertical` and `overflow: hidden`. The stylesheet already uses this idiom; match whatever is there rather than inventing a second one.
4. **Add the expander.** In `dossier.tsx`'s `CandidateColumn`, wrap the reported claim so it clamps by default with a control that expands it in place. The control must be a real `<button>` with a text label ("Read the full claim" / "Show less"), reachable by keyboard, with `aria-expanded`. Do not add `data-testid`.
5. **Clamp the lists.** Apply the same treatment to strengths and risks: show three items, then an `N more` button that reveals the rest. Compute `N` from the real array length; never hard-code.
6. **Respect reduced motion.** If the expander animates at all, wrap the transition in `@media (prefers-reduced-motion: no-preference)`. The repo has no global reset, so an unguarded transition ships to everyone.

## 6. Data, API, migration

None. This phase is CSS plus one component's local expand/collapse state. No server, schema, or wire change.

## 7. Tests and verification

Extend, do not replace:

- `test/ensemble-dossier-render.test.ts` - assert the claim renders clamped by default and that the expander control is present with an accessible name. Add a case proving a short claim gets no expander.
- `test/panel-vote-render.test.ts` - its class-vs-stylesheet assertion must still pass with any new class.
- `test/ensemble-page-render.test.ts` - existing scorecard assertions must survive; adjust only what the clamp genuinely changes.

Commands:

```sh
node --test --test-concurrency=2 --import tsx test/ensemble-dossier-render.test.ts
node --test --test-concurrency=2 --import tsx test/panel-vote-render.test.ts
node --test --test-concurrency=2 --import tsx test/ensemble-page-render.test.ts
npm run typecheck && npm run lint && npm test
```

**Playwright spec required.** The repo requires an `e2e/` spec for every UI change, with no exemptions. Add one asserting the claim is bounded and the expander reveals the rest. Read `e2e/README.md` first - specs drive the *built* dashboard, so `npm run build` precedes `npm run test:e2e`, every agent binary is redirected at a fake, and selection is by role/label/placeholder only.

If seeding a completed ensemble run with a recorded comparison turns out to be expensive in `e2e/`, say so in the PR and propose the cheapest honest coverage rather than silently skipping the spec.

## 8. Merge and exit criteria

- Ensemble result prose computes to 12.5px with a declared line-height; nothing in the subtree inherits 16px.
- No candidate claim renders taller than its clamp until expanded.
- Expander is keyboard reachable and carries `aria-expanded`.
- Every new class has a stylesheet rule.
- Typecheck, lint, unit tests, and the new e2e spec pass.

## 9. Downstream handoff

Phase 2 may rely on:

- **The prose scale is declared, not inherited.** Phase 2 must not re-declare it per-cell.
- **A bounded-prose class exists** with a lines custom property, and an expander pattern already proven against the render tests. Phase 2 reuses both inside its criteria cells rather than inventing a second clamp.
- **`CandidateColumn` still exists and is still shared with `PanelVote`.** Phase 2 must not delete or repurpose it; see that phase's contract.

Phase 2 must not change: the declared prose sizes, or the clamp class name, without updating this phase's tests in the same PR.

## 10. Cross-phase audit record

- **Written first, no prior phases to reconcile.**
- Reconciled against Phase 2 after it was written: Phase 2 consumes the clamp class and the expander rather than defining its own, and leaves `CandidateColumn` in place for `PanelVote`. No change needed here.
- Reconciled against Phase 3: Phase 3 touches `EnsembleTimeline.tsx` and a separate region of `styles.css`. No shared class or selector with this phase. Confirmed concurrent-safe.
