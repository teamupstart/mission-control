# Phased plan: the ensemble decision dossier

Source plan: [`plan.md`](plan.md) (approved 2026-08-01, Direction A - The Scoreboard). Rendered: [`plan.html`](plan.html).

Three phases. Phase 1 is the foundation, Phase 2 depends on it, Phase 3 is independent of both and can run alongside them.

## Incorporated decisions

| Question | Answer | Where it lands |
| --- | --- | --- |
| Direction | **A - The Scoreboard** | Phase 2 |
| Floor fixes | **Declare the prose type scale**, plus bounding the prose | Phase 1 |
| Event log rewrite | **Include it now** | Phase 3 |
| Follow-up | Create phased implementation plan | this document |

Deferred by decision, owned by **no phase**: resolving the anonymised `Submission A/B/C` labels (and the `subjectLabel` wire change that would require), and the status-colour cascade onto body prose in the Members section. Their evidence stays in `plan.md` sections 2.3 and 2.4 because it is measured and still true.

Bounding the prose was not among the selected floor fixes but is included, because Direction A's criteria-row layout is not buildable without it: a cell that can grow without limit destroys the row alignment that is the whole point. This was stated to the human and confirmed - *"bound the prose if you need to, do whatever you need to support A."*

## Investigated findings that shaped the split

These were checked against the repository, not taken from the source plan:

1. **"No wire change" holds.** Both new criteria rows use data the client already has. Diffstat is already rendered at `dossier.tsx:191` via the web-side type at `src/web/ensembles/types.ts:72`; elapsed derives from attempt `startedAt` / `finishedAt` in `src/shared/ensemble.ts`. No server, schema, or route change anywhere in this plan.

2. **`CandidateColumn` is shared, and that shapes Phase 2's design.** `src/web/ensembles/results/dossier.tsx` exports it; **both** `BestOfN.tsx` and `PanelVote.tsx` import it. `Consensus.tsx` uses neither it nor the scorecard classes. Transposing Best-of-N in place would silently redesign Panel vote, which is outside the approved scope. Phase 2 therefore adds a presentation and shares the data shaping, rather than rewriting the component.

3. **Prose classes are shared, and that is desirable.** Phase 1's type-scale fix lands on Best-of-N and Panel vote together. Both get readable prose for free; neither changes layout.

4. **The repo cross-checks rendered classes against the stylesheet.** Tests such as `test/panel-vote-render.test.ts:311` and `test/attention-inbox.test.ts:315` assert "every class X renders has a rule in the stylesheet". Every phase that adds a class adds a rule and the matching assertion.

5. **Four render tests cover this markup** and will need updating rather than replacing: `test/ensemble-dossier-render.test.ts` (575 lines), `test/ensemble-page-render.test.ts` (941), `test/panel-vote-render.test.ts` (328), `test/ensemble-consensus-render.test.ts`. `panel-vote-render` is the canary - if Phase 2 breaks it, `CandidateColumn` was changed when it should not have been.

6. **Every phase needs a Playwright spec.** The repo requires one for any UI change with no exemptions, and this surface currently has none. The cost of seeding a completed ensemble run with a recorded comparison in `e2e/` was **not** verified; each phase instructs the implementer to read `e2e/README.md` first and to report honestly if the seeding turns out to be expensive rather than silently skipping the spec.

## Phases

| # | Phase | File | Depends on | Delivers |
| --- | --- | --- | --- | --- |
| 1 | Prose type scale and bounded claims | [`phase-1-prose-scale-and-bounds.md`](phase-1-prose-scale-and-bounds.md) | - | Prose at 12.5px/1.55 instead of the inherited 16px/normal; no claim can set a row's height |
| 2 | The Scoreboard | [`phase-2-scoreboard.md`](phase-2-scoreboard.md) | Phase 1 | Criteria as rows, the margin ruler, an Elapsed row, aligned Recommended badge |
| 3 | The event log in the operator's words | [`phase-3-event-log-words.md`](phase-3-event-log-words.md) | - | Humanised, stage-grouped event log; no raw enums |

## Dependency graph

```
Phase 1 ──▶ Phase 2
Phase 3 (independent)
```

Concurrency groups:

- **Group A:** Phase 1, then Phase 2.
- **Group B:** Phase 3, any time.

Phase 1 and Phase 3 may start together. Phase 2 starts once Phase 1 merges. Phase 2 and Phase 3 may merge in either order.

## Cross-phase contracts

1. **The prose scale is declared once, in Phase 1.** Phase 2 consumes it and must not re-declare sizes per cell.
2. **One clamp implementation.** Phase 1 owns the bounded-prose class and the expander pattern. Phase 2 reuses both; a second clamp is a defect.
3. **`CandidateColumn` stays, and stays serving Panel vote.** Phase 2 must not delete or repurpose it. `test/panel-vote-render.test.ts` passing untouched is the enforcement.
4. **Presentation may diverge; data shaping may not.** Phase 2 extracts one criteria-shaping helper consumed by both presentations. Two renderers over one shaping function is fine; two derivations of a candidate's numbers is a second source of truth and is not.
5. **No wire change, in any phase.** If implementation reveals a genuinely missing client-side field, stop and report rather than adding a route change - "no wire change" is a load-bearing claim of the approved plan.
6. **One vocabulary.** Phase 3 must not add a fourth spelling of the run state, and must not introduce `Submission X` into labels while resolution is deferred.
7. **`src/web/styles.css` is shared by all three phases** in far-apart regions. Auto-merge is expected to be clean; whichever phase lands last re-runs the full unit suite rather than trusting the textual merge.

## Final verification

Per phase: `npm run typecheck`, `npm run lint`, `npm test`, plus the phase's Playwright spec (`npm run build` first, and `npx playwright install chromium` once per machine).

After all three merge:

- `npm run typecheck && npm run lint && npm test && npm run build && npm run smoke && npm run test:e2e`
- Visual check of the Best-of-N dossier against a real completed run at 1440px and 1024px: criteria rows align, no cell exceeds its bound, no horizontal page scroll.
- Panel vote and Consensus visually unchanged from before Phase 1.

## Known environment caveat

This machine runs **Node v25.9.0**, an odd-numbered unstable release; the project declares `>=24` and CI validates 24 and 26. `test/codex-rollout.test.ts:196` fails deterministically here and is unrelated to this plan (it reproduces with the source tree byte-identical to `main`). Implementers should not treat that failure as caused by their phase, and should confirm their own runs against a supported Node version.
