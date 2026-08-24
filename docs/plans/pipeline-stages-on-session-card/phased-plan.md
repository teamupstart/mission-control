# Phased plan - Pipeline stages on a session card

Source plan: [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html)).
Design record: [`mockups.html`](mockups.html).

**This is a one-phase plan.** One phase, one implementation task. The rationale is below rather
than assumed.

## Incorporated human decisions

Submitted through `request_plan_decisions` and already written into `plan.md`:

| Decision | Adopted | Owned by |
| --- | --- | --- |
| Treatment | **A - phase meter.** Segmented bar, proportional widths, ~11px. | Phase 1, steps 2 and 6 |
| Popover | **Extend `Tooltip` to accept a `ReactNode` label.** One primitive. | Phase 1, step 1 |
| Surfaces | **Board tile only.** Console rail and detail band keep today's chip. | Phase 1, steps 4-5 and non-goals |
| Correlations | **Externally driven workers only** (`Session.pipeline`). | Phase 1, step 4 gate and non-goals |
| Follow-up | **Create phased implementation plan.** | This document |

Options B (step barcode) and C (phase pips) are out of scope and retained in `mockups.html` as
the record the decision was made against.

## Investigated findings that changed the shape of the work

The source plan's assumptions were tested against the repository. Three results mattered.

### The feature needs no new data path, which is why it is one phase

The source plan claimed the run is already in the browser. Confirmed concretely:

- `useEventStream` holds `pipelineRuns` keyed by run identity
  (`src/web/useEventStream.ts:197`, `:281`, `:437`).
- `App.tsx` derives `pipelineRunByKey` (`:1737`) and passes it down (`:2070`);
  `SessionViewProps.pipelineRunByKey` is `ReadonlyMap<string, PipelineRun>`
  (`layouts/types.ts:242`).
- `BoardView` already reads that map (`BoardView.tsx:167`).
- `pipelineRunKeyOf` accepts `{ provider, repoRoot, slug }` structurally
  (`src/shared/pipeline.ts:407`), so a `SessionPipelineLink` needs **no adapter**.

So there is no contract phase, no migration phase, and no server phase to sequence. The whole
feature is browser-side, and the only new data movement is one map lookup. **A plan with no
persistence, no wire change, and no migration has no natural early phase to put first**, which is
the single biggest reason this is not split.

### The existing fold covers the whole view model

`pipelineStrip`, `pipelinePhaseStatus` (with `degraded`), `pipelineStepStatus` and
`pipelineEyebrow` in `src/web/pipelines/pipeline-run-model.ts` already produce everything the
meter draws. `pipelinePhaseStatus` reads only `step.state`, never a gate verdict, so
`pipelineStrip` can be called with an empty gates array and the card needs **no fetch**. That
removed the one candidate for a "data" phase.

### One correction to the source plan's implied scope

The source plan's file table listed a new component under `src/web/pipelines/` plus edits to five
existing files. The repository confirms all six, and adds a detail the plan did not state: the
rich tooltip bubble also needs a **class hook**, because `.tooltip` is `text-align: center` with
its own padding and `max-width: 260px` (`styles.css:20909`). So widening `Tooltip` is not only a
prop change - the component must mark the bubble as rich so CSS can switch layout. Recorded in
Phase 1, step 1.

Also confirmed and worth carrying: the bubble is already `aria-hidden` and already
`pointer-events: none`, so rich content is safe for accessibility and cannot steal hover from the
segment that opened it - but it must stay non-interactive, which the design is.

## Sizing estimate

Gross non-test implementation lines expected to be added or materially changed, in this
repository's comment-heavy style:

| Area | Estimate |
| --- | --- |
| New phase-meter leaf under `src/web/pipelines/` | 175-230 |
| `src/web/styles.css` - meter, segments, tones, hatch, ring, extras marker, rich bubble | 110-145 |
| `src/web/components/Tooltip.tsx` - additive node arm plus bubble class | 30-45 |
| `SessionTile.tsx`, `BoardView.tsx`, `board-card.ts` | 25-35 |
| **Total** | **~340-455** |

Revised in review round 1: the extras marker for unplaceable and out-of-band steps added roughly
25 component lines and 15 of CSS. It does not change the phase count - the reasoning below turns
on there being no foundational layer to land first, which the addition does not affect.

Assumptions: the existing fold is imported rather than reimplemented (which is a hard requirement
of the phase, not an optimisation); CSS is counted as implementation; `docs/pipelines.md` prose
and all test files are excluded.

This is a planning signal, not a promise about diff size.

## Phase count rationale

The estimate is above the 200-line one-shot threshold, so the default of one phase has to be
justified rather than assumed. It holds:

- **There is no foundational layer to land first.** No schema, no migration, no persisted field,
  no route, no SSE frame, no MCP tool. The usual reason to phase - a contract that consumers must
  wait for - does not exist here.
- **The only natural boundary is a small preparation phase, which the rubric forbids.** Splitting
  the `Tooltip` widening out is roughly 35 lines and would deliver an unused API arm with no
  user-visible behavior. That is precisely the "small preparation phase" the sizing rules exclude,
  and it would also leave the meter's popover unbuildable until the second phase merged.
- **Splitting by layer would create a dead surface.** A meter with no popover, or a registry entry
  with no region, are both half-features; the plan's own value is the hover detail.
- **The risk profile is low for the size.** No concurrency, no state machine, no compatibility
  window, no data at rest. The complexity is concentrated in CSS geometry and one additive prop
  widening, both locally testable and both covered by existing guard tests
  (`tooltip-coverage`, `board-card-items`, `board-tile-render`).
- **It is within a mid-tier model's reach** because the hard thinking is already done: the fold
  exists, the tones exist, the tokens exist, `.wf-tile-peek` is a close precedent, and the phase
  file names every file and every tolerance rule.

Combining is therefore both safer and more reviewable than splitting.

## Phases

| # | Phase | File | Direct prerequisites | Task |
| --- | --- | --- | --- | --- |
| 1 | The phase meter on the board card | [`phase-1-phase-meter-on-the-board-card.md`](phase-1-phase-meter-on-the-board-card.md) | None | One implementation task |

### Dependency graph

```mermaid
flowchart LR
  P["planning session PR<br/>publishes the artifacts"] --> T1["Phase 1<br/>phase meter on the board card"]
```

Every phase task additionally depends on this planning session, so nothing dispatches until the
pull request carrying these artifacts merges to the default branch. With one phase there is
nothing else in the graph.

### Concurrency and merge order

One phase, so there is no concurrency group and no merge ordering to observe. It merges whenever
it is green.

The phase touches **one repository** (this one), so it produces one pull request.

## Cross-phase contracts

With a single phase these are not handoffs between phases; they are the contracts a **future**
change should inherit rather than relitigate. Stated here so they are findable from the index:

- `Tooltip`'s label is `string | TooltipContent`. A future rich tooltip uses that arm; it does
  not add a second hover primitive, and it never puts markup in the description node that
  `aria-describedby` resolves to.
- The meter reads `pipelineStrip` / `pipelinePhaseStatus`. Extending it to the console rail row,
  the detail band, or a managed Pipeline host is a rendering change at the leaf's call sites - not
  a new fold, and not a wire change.
- `SessionPipelineLink` stays as it is. The pattern for "the card needs more about a run" is the
  client-side join, not a wider session frame.
- The board-card registry id is the persisted operator preference (`hiddenDisplayItems` stores
  ids), so renaming it later is a preference migration.
- The tolerance rules are load-bearing: geometry from `run.steps`, unknown steps counted in the
  total and readable in the extras marker, out-of-band steps never given a segment and never
  counted in the total. The rule behind them is **anything the meter counts must be readable
  somewhere on the meter** - a later surface that adds a count without a home breaks it.

## Final verification strategy

Owned by Phase 1 and listed in full in its file. In summary:

- Fold tests over a mid-run, halted, all-skipped S-tier, stale/kicked-back, unknown-step,
  out-of-band-step, one-step-phase, no-extras, and empty-step-list run.
- A test asserting segment tones come from `pipelinePhaseStatus`, which is what stops a second
  fold appearing later.
- `board-tile-render`, `board-card-items` and `tooltip-coverage` stay green, plus a new `Tooltip`
  node-arm test asserting the description node is plain text.
- A **required** `e2e/` spec: the meter appears for a correlated session, hovering a segment
  reveals that phase's status, and the Settings row hides it. No `data-testid`, no model tokens.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.
- Visual evidence on a real board card in the built dashboard, running and halted states, normal
  and narrow column widths, attached to the pull request and never committed.

The final state matches the source plan with no cleanup deferred to anything outside Phase 1.
