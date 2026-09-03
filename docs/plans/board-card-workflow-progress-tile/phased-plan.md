# Board card workflow progress tile - phased implementation

Implementation index for [plan.md](plan.md). One phase, one merge unit, one task.

## Source plan and incorporated decisions

Source of truth: [`docs/plans/board-card-workflow-progress-tile/plan.md`](plan.md), rendered as
[`plan.html`](plan.html).

Human selections submitted through the Mission Control dashboard on 2026-09-03, already written
into the source plan and treated here as requirements rather than options:

| Decision | Adopted | Consequence for this plan |
| --- | --- | --- |
| Design | **Option B** - stage track plus repair-round budget meter | Three rows under the existing header: stage track with count, caption, repair pips. The round counter leaves the header. |
| Setting mechanism | **New `DISPLAY_ITEMS` entry** | One registry line, absent from `UI_CONFIG_DEFAULTS.hiddenDisplayItems`, so it ships on. No new persisted field. |
| The 250px name/status collision | **Fix in the same change** | In scope, with width-dependent regression coverage. |
| Follow-up | Create a phased implementation plan | This document. |

Options A and C were considered and are recorded as not-taken in the source plan.

## What the repository said

Investigated before drawing any boundary. Five findings changed the plan; the first three are
load-bearing, and the third corrected a design decision that would have shipped a false alarm.

### 1. The settings preview renders the placeholder, not the peek - verified

`BoardCardPanel` mounts a real `SessionTile` with `workflowStageDetail="summary"`
(`src/web/components/BoardCardPanel.tsx:147`). `WorkflowLadderPanel` maps that to
`summaryOnly` and passes a **null run id** to `useWorkflowRunDetail`, so it fetches nothing and
renders `WorkflowLadderPeekPlaceholder` (`src/web/workflows/WorkflowLadder.tsx:744`, `:777`).

Confirmed by rendering the panel through the suite's own harness rather than by reading the code.
The preview markup contains `is-placeholder` and `wf-tile-peek-round`, and contains **no**
`wf-tile-peek-rung`:

```text
is-placeholder present: true
wf-tile-peek-rung present: false
wf-tile-peek-round present: true
unavailable copy present: true
```

This matters because `test/board-card-items.test.ts:114` - "the panel's preview populates every
item, so no checkbox looks broken" - asserts that unchecking **each** registry item changes the
rendered panel markup. There is no stage data in the preview at all, so a stage bar alone could
not satisfy it.

**Option B satisfies it and the other two designs would not.** The repair row reads
`summary.round` and `summary.maxRepairRounds` (`src/shared/workflow.ts:3605`, `:3673`), both of
which the placeholder already has and already prints as `R1 / 5`. Toggling the new item therefore
changes the placeholder's own markup - the round leaves the header and the pip row appears -
without any fabricated run detail. Options A and C would have needed a fixture `WorkflowRunDetail`
carrying invented stages, personas and deliveries, which is exactly what
`src/web/lib/board-card-preview.ts:175` argues against in its own comment.

Consequence for the phase: **the placeholder is variant-aware too**, not just the peek. That is
implementation scope, and it is the reason the fixture needs no new run detail.

### 2. `board-card-items.test.ts`'s default-state test needs its rationale corrected

`test/board-card-items.test.ts:172` asserts `hiddenDisplayItems` defaults are exactly
`["worktree"]` and then loops every item asserting it ships visible. A default-on
`workflowProgressBar` passes both assertions mechanically.

Its comment does not survive: *"Every other id names something a card already drew, so its absence
from this list is what makes an upgrade move nothing on screen."* This item is default-on and
**does** move something on screen for an existing operator - that is the requirement. The comment
becomes false the moment the entry lands, so correcting it is part of this phase rather than a
later tidy.

### 3. `R6 / 5` is the top of the legal range, not an overrun - the design was wrong

The plan as first written called `b5659b19`'s `R6 / 5` a "repair budget overrun" and proposed a red
overflow pip appended past the meter. The repository says otherwise, and the correction is
load-bearing because the original would have drawn an alarm on a healthy run.

`maxRepairRounds` counts **repair** rounds *after* the initial submission
(`src/shared/workflow.ts:136`): "a new one is created while `round <= maxRepairRounds`, so the
highest round a run can reach is `maxRepairRounds + 1`". So the legal range is 1 to
`maxRepairRounds + 1`, and R6 against a budget of 5 is the **last round the run can afford**, not an
illegal state. `b5659b19` is sitting there with `status: "completed"` and a passed end - it used its
whole budget and succeeded.

`round > maxRepairRounds` is already a named inequality: `workflowRunGaveUp`
(`src/shared/workflow.ts:1763`) reads exactly it for "another round is not affordable", and
`grantRepairRounds` (`src/server/workflows/manager.ts:2494`) revives such a run by raising
`maxRepairRounds` rather than by letting `round` exceed the range. The meter must reuse that
inequality, not invent a third reading of the same two fields - and it needs no overflow case,
because a granted budget grows the meter by a pip.

Verified against the live population: across 31 runs the observed rounds are
`{1:6, 2:15, 3:6, 4:2, 5:1, 6:1}` with `maxRepairRounds` uniformly 5, and **zero** runs above
`maxRepairRounds + 1`.

Consequences, all now in the source plan and this phase:

- The pip count is `maxRepairRounds + 1`, not `maxRepairRounds`. Off by one in the first draft.
- The last pip being current is danger-toned **and** accompanied by the words `no repairs left`. A
  lone red dot in a row of grey ones would read as a round that failed; what it means is that no
  further round is affordable.
- No overflow pip, and no out-of-range branch to test.

### 4. The segmented bar already exists and must not be forked

`PipelinePhaseMeter` (`src/web/pipelines/PipelinePhaseMeter.tsx:206`) draws a segmented bar with
`.tpm-seg` (`src/web/styles.css:27000`): neutral track, `min-width: 9px` hittability floor,
`is-now` outline ring, `is-degraded` hatch, per-segment `flexGrow`, and an inner `<i>` at a
rounded fill percentage. Every one of those decisions is argued in a comment and every one is a
decision the workflow meter needs identically.

Both meters can appear on the same card - `SessionTile.tsx:283` (`pipelinePhases`) and `:293`
(`workflow`) are independent gates, not alternatives - so they must not merely look alike. They
must be the same component. Extracting it is in scope.

### 5. The collision is real and width-dependent

`.wf-tile-peek-title strong` is `flex: none` (`src/web/styles.css:26645`) and
`.wf-tile-peek-state` is `flex: none; margin-left: auto` (`:26656`). Neither yields, so at a 250px
column - `.board-col`'s own `min-width` (`:24868`) - the 8px gap collapses and "Intent Conformance
Judge" runs into "Waiting". Invisible at 300px, which is why no existing test catches it.

## Sizing and phase count

Estimated **260 to 400 gross non-test implementation lines**, assuming the shared segment bar is
extracted rather than duplicated and that the CSS is written in the house style with its decisions
commented (which is most of the variance):

| Area | Estimate |
| --- | --- |
| Shared segment meter extracted from `PipelinePhaseMeter`, plus rewiring its one existing caller | 60-90 |
| `WorkflowStageMeter` - stage track, count, caption, repair pips | 80-110 |
| Variant-aware placeholder (repair row from the summary alone) | 20-30 |
| Variant threaded through `WorkflowLadderPanel`, `SessionTile`, and the peek | 20-30 |
| `styles.css` - meter, pips, and the collision fix | 70-110 |
| `DISPLAY_ITEMS` entry and settings-search keywords | 10-15 |
| **Total** | **260-400** |

Tests are excluded from the estimate and are implementation work inside the phase: unit coverage
for the exported stage projection and the repair-pip model, the `board-card-items` additions and
comment correction, a width-dependent regression for the collision, and the required Playwright
spec.

**One phase.** Above the 200-line one-shot threshold the rubric still defaults to one phase, and
neither exception applies here:

- The only candidate boundary is "extract the shared segment bar" as its own merge unit. Rejected:
  it is ~75 lines, it is a deliberate no-behavior-change refactor, and it would land a shared
  component whose only caller is the one it already had. That is a preparation phase producing a
  near-dead surface, which the rubric names specifically.
- The rest is one vertical slice. Splitting the registry entry from the component it governs would
  ship a checkbox with nothing behind it; splitting the placeholder from the peek would ship a
  setting that works on the board and does nothing in its own preview - and fail
  `board-card-items.test.ts` in between.
- The collision fix belongs with the work that promotes the rung tile to a deliberate fallback
  view. On its own it is a five-line CSS change nobody would open a pull request for; here it is
  the reason the fallback is correct at every width the board allows.

So: no dependency graph, no concurrency groups, no cross-phase contracts. One task, gated on this
planning session's pull request merging.

## Phases

| Phase | File | Outcome | Direct prerequisites | Repository |
| --- | --- | --- | --- | --- |
| 1 | [`phase-1-workflow-progress-meter.md`](phase-1-workflow-progress-meter.md) | The stage track and repair-budget meter ship as the default board card tile, with a checkbox returning today's rung tile, and the rung tile is correct at 250px | none (this planning session's PR) | source repository only |

## Scheduled task

| Phase | Task id | Direct prerequisites | Concurrency |
| --- | --- | --- | --- |
| 1 | `ff039ebc-2eb1-432f-abb0-4a413bb3cede` | this planning session's pull request | n/a - single task |

Backlogged until the pull request carrying these artifacts merges, because the task names their
paths rather than restating their content.

## Merge order

One pull request, after this planning session's artifact pull request merges.

## Final verification strategy

Owned by Phase 1 and specified in its file. In summary: `npm run typecheck`, `npm run lint`, the
targeted `node --test` files, `npm run build`, and `npm run test:e2e` for the required Playwright
spec - the last two because a Board surface changed. Plus a visual check at both 250px and 300px
board column widths, because the collision this change fixes is invisible at one of them and the
height table in the source plan was measured at both.
