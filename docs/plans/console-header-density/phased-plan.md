# Phased plan: console detail header density

Source plan: [`plan.md`](plan.md). Mockups: [`mockups.html`](mockups.html).

## Incorporated human decisions

All four are requirements, taken from the design review recorded in the source plan.

- **D1** - implement option 2, "Tabs are the toolbar": keep the `PATH`/`BRANCH` row, fold the
  worktree row's controls into the tab strip.
- **D2** - the `SHIP` badge renders only for `scout`; the task title renders only when it differs
  from `session.name`.
- **D3** - `ModePicker` leads the header cluster (`auto · model · context · cost`) and leaves the
  footer.
- **D4** - live status splits by tempo: the objective joins the identity block, the activity becomes
  a trailing row in the transcript log.

## Investigated findings that bind implementation

Full detail in the source plan under "Repository findings". The three that shape the phase
boundaries:

- **F1** - the launcher strip has a single deliberate mount in `TranscriptPanel` that serves three
  surfaces. Relocating it into `.detail-tabs` deletes it from Cards and breaks the `t`/`a` chords
  there. It must be lifted into a host-provides-toolbar arrangement, not moved.
- **F2** - `.detail-tabs` is not a query container, so the move forfeits the pane's only responsive
  mechanism. The give-way must follow `topbarLadder.ts`, including its rule that shed labels go
  visually hidden rather than `display: none`.
- **F4** - a trailing row in the log breaks stick-to-bottom in two distinct ways, both owned by the
  phase that introduces the row.

## Phases

| # | Phase | File | Direct prerequisites |
| --- | --- | --- | --- |
| 1 | Header identity band | [`phase-1-header-identity-band.md`](phase-1-header-identity-band.md) | none |
| 2 | Live activity in the transcript | [`phase-2-live-activity-in-transcript.md`](phase-2-live-activity-in-transcript.md) | Phase 1 |
| 3 | Tabs are the toolbar | [`phase-3-tabs-are-the-toolbar.md`](phase-3-tabs-are-the-toolbar.md) | Phase 2 |

## Dependency graph

```
Phase 1  (header identity band: task pill, ModePicker, objective)
   |
Phase 2  (activity -> trailing row in the log, scroll anchoring)
   |
Phase 3  (launcher strip into the tab row, give-way ladder)
```

## Concurrency groups

**There are none. This graph is deliberately serial**, and the reason is file ownership rather than
logical dependency:

- All three phases edit `src/web/components/layouts/ConsoleDetail.tsx` and the single stylesheet
  `src/web/styles.css`. There is exactly one stylesheet in this project.
- Phases 2 and 3 both edit `src/web/components/TranscriptPanel.tsx` - phase 2 in the log body, phase 3
  in the toolbar mount and the panel's prop contract.
- Phase 3 depends on phase 2 for a settled `.detail-conv` shape: phase 2 removes the leading children
  of that container, and phase 3 changes what sits above it. Landing them concurrently would put two
  agents in the same 40 lines.

Splitting further would not buy concurrency, only more conflicts. The chain is short by design.

## Merge order

1, then 2, then 3. Each leaves the repository operable, typechecking, and with a passing suite; none
depends on an unmerged later phase to repair an intermediate state.

## Cross-phase contracts

| Contract | Introduced by | Consumed by | Rule |
| --- | --- | --- | --- |
| `.detail-title` is a column that holds the `h2` and an optional `.objective` | Phase 1 | Phase 3 | Phase 3 may re-flow the head row but must not flatten this back to a single line. |
| The header cluster order is mode, model, context, cost | Phase 1 | Phase 3 | Phase 3's give-way ladder sheds from this cluster last, and never sheds the mode chip's accessible name. |
| `.detail-conv` keeps its leading children removed and `.transcript` as a direct child | Phase 2 | Phase 3 | `.detail-conv > .pane-dialog` and `.detail-conv > .transcript` are child combinators in shipped CSS and a passing test; no phase may introduce a wrapper. |
| The trailing log row is the current turn's in-progress state, not a second activity feed | Phase 2 | Phase 3 | Phase 3 must not reintroduce `session.activity` into the header while relaying out the bands. |
| `TranscriptPanel` renders its own toolbar unless the host provides one | Phase 3 | - | Cards keep the panel-owned strip; console detail and board drill-in use the host-owned one. Both must register launchers so `t`/`a` work in every host. |

## Final verification strategy

Per phase: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` before the e2e suite.
Every phase is a UI change, so every phase adds at least one Playwright spec under `e2e/` and runs
`npm run test:e2e`; there are no exemptions in this repository.

Across the set, after phase 3 merges:

- The Conversation tab shows a conversation area of ~410px in a 600px pane, up from 243px.
- No control that existed before the change has been removed from any surface. Specifically, Cards
  still have the launchers and the Terminal-view toggle, and `t` / `a` still work there.
- `npm run test:e2e` passes with the three new specs, including the narrow-viewport give-way spec
  modelled on `e2e/specs/topbar-one-row.spec.ts`.
- The docs listed in the source plan's F-findings no longer contain false sentences.

## Cross-phase audit record

- **After phase 1** - no earlier phases to reconcile. Confirmed phase 1 owns the `.detail-title`
  column and the cluster order, both of which phase 3 inherits rather than redefines.
- **After phase 2** - moved the "no wrapper inside `.detail-conv`" rule from phase 3 into phase 2,
  because phase 2 is the phase that edits those children and would be the one to break the child
  combinator. Phase 3 now consumes the rule instead of restating it.
- **After phase 3** - confirmed phase 3 does not need to re-open the task pill or the mode chip.
  Checked that the give-way ladder sheds only labels phase 1 introduced as text, never the mode
  chip's accessible name, and recorded that constraint in the cluster-order contract above.
- **Final** - every decision D1-D4 is owned by exactly one phase: D2 and D3 by phase 1, D4 split
  across phase 1 (objective) and phase 2 (activity) as the decision itself splits, D1 by phase 3.
  Every consumer follows its prerequisite. No phase depends on undocumented cleanup by another.
