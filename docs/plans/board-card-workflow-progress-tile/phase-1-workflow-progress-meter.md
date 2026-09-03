# Phase 1 - Workflow progress meter on board cards

The only phase. See [`phased-plan.md`](phased-plan.md) for the sizing and the one-phase rationale,
and [`plan.md`](plan.md) for the approved design and the live-run comparison.

## Outcome

A Board session card carrying a stage-shaped workflow run draws its whole pipeline as a **stage
track with a repair-round budget meter** instead of one stage rung: five segments instead of one
name, a skipped stage distinguishable from a pending one, and "how much repair budget is left" as a
meter rather than arithmetic on `R2 / 5`.

It ships **on**. A new checkbox in Settings › Display › Session display returns today's rung tile
for an operator who prefers it, and that fallback view is now correct at every board column width
the app allows.

## Entry criteria and dependencies

- Direct phase prerequisites: **none**. This is the only phase.
- The planning session's pull request must merge first, which publishes this file and its siblings.
  The scheduled task is gated on that.
- Baseline confirmed green before starting:
  `node --test --import ./test/setup-state.mjs --import tsx test/board-card-items.test.ts` - 17
  passing.

## Scope

In:

- A shared segmented-bar component extracted from `PipelinePhaseMeter`, with that meter rewired to
  consume it.
- A `WorkflowStageMeter`: stage track, cleared-stage count, active-stage caption, repair-round pips.
- The summary-only placeholder made variant-aware, so the meter's repair row draws from the run
  summary alone.
- The `workflowProgressBar` registry entry, its gate in `SessionTile`, and the variant threaded
  through `WorkflowLadderPanel`.
- The 250px stage-name/status collision in the rung tile.
- Unit, markup, and Playwright coverage for all of the above.

Not in:

- Any change to `workflowLadderPeekView`'s **choice** of rung. The projection is reused, not
  retuned; the caption names the same stage the tile names today.
- The expanded ladder (`WorkflowLadder`), the Runs view, `SessionWorkflowsPane`, and the console
  detail. Only the collapsed board tile changes.
- The ai-conductor pipeline meter's behavior or appearance. It gains a shared implementation and
  must render identically.
- Any new persisted `UiConfig` field. The decision was the registry.
- Options A and C from the source plan. Recorded as not-taken there.

## Repository findings this phase must honor

All five are stated with evidence in [`phased-plan.md`](phased-plan.md#what-the-repository-said).
The three that change code you would otherwise write:

1. **The settings preview has no run detail.** `BoardCardPanel` mounts `SessionTile` with
   `workflowStageDetail="summary"` (`src/web/components/BoardCardPanel.tsx:155`);
   `WorkflowLadderPanel` maps that to a null run id, fetches nothing, and renders
   `WorkflowLadderPeekPlaceholder` (`src/web/workflows/WorkflowLadder.tsx:744`). Verified by
   rendering the panel: the markup has `is-placeholder` and no `wf-tile-peek-rung`.

   `test/board-card-items.test.ts:114` requires unchecking **every** registry item to change the
   panel markup. So the placeholder must be variant-aware. It can be, without any fixture: the
   repair row needs only `summary.round` and `summary.maxRepairRounds`, both already on
   `WorkflowRunSummary` and already printed there as `R1 / 5`. Do **not** add a fabricated
   `WorkflowRunDetail` to `src/web/lib/board-card-preview.ts`; its own comment at `:175` explains
   why, and this design does not need one.

2. **`round > maxRepairRounds` means "no further round is affordable", not "overrun".** The legal
   range is 1 to `maxRepairRounds + 1` (`src/shared/workflow.ts:136`). Pip count is
   `maxRepairRounds + 1`. Reuse `workflowRunGaveUp`'s inequality
   (`src/shared/workflow.ts:1763`) rather than restating it, and note that `workflowRunGaveUp`
   itself also requires a blocked run and a spent phase - the pip row is about the budget alone, so
   it must not borrow the status half of that predicate. There is no out-of-range case.

3. **The segmented bar exists.** `.tpm-seg` (`src/web/styles.css:27000`) and the JSX at
   `src/web/pipelines/PipelinePhaseMeter.tsx:279` already settle the neutral track, the 9px
   hittability floor, the `is-now` outline ring, the `is-degraded` hatch, and the rounded fill
   percentage, each with its reasoning in a comment. Both meters can appear on one card
   (`SessionTile.tsx:283` and `:293` are independent gates), so share the implementation.

## Implementation steps, in execution order

### 1. Extract the shared segment bar

New module - suggested `src/web/components/SegmentMeter.tsx` - exporting a bar that takes an ordered
list of `{ key, tone, fillPercent, grow, current, degraded, label, tooltip }` and renders the
`.tpm-bar` / `.tpm-seg` structure with its `Tooltip` and `tabIndex={0}` per segment.

Move the `fillPercent` rounding helper (`PipelinePhaseMeter.tsx:199`) and its comment with it.
Rename the CSS to a neutral prefix **or** keep `.tpm-*` and have both callers use it - either is
fine, but do not end up with two rulesets. Carry every existing comment across; they are the record
of why each value is what it is.

Rewire `PipelinePhaseMeter` to consume it. Its popovers stay its own - they are about pipeline
steps - so the shared component takes the tooltip content as a prop rather than owning it.

**Exit condition for this step: the pipeline meter renders byte-identically.** Prove it, do not
assume it - render `PipelinePhaseMeter` against `PREVIEW_PIPELINE_RUN` before and after and compare
the markup.

### 2. Export the stage projection

`workflowLadderPeekView` already builds the full per-stage list and discards all but one
(`src/web/workflows/WorkflowLadderPeek.tsx:181`). Lift that map into an exported
`workflowLadderStages(summary, detail): StagePeek[] | null`, and have `workflowLadderPeekView`
consume it so the two can never disagree about a stage's status. Export `StagePeek` too.

Keep `peekPriority` and the early returns (uncertain delivery, Inspector gate, `inspector_only`
round) exactly where they are. The meter is for the stage-shaped case only.

### 3. Build `WorkflowStageMeter`

Three rows, per [`plan.md`](plan.md#the-design):

- **Stage track.** One segment per stage, equal `grow`. Fill solid on `passed` and `failed`; fill
  **hatched** on a carried pass or any `degraded` status - a resolved-without-running stage is not
  pending and must not look it; leave the track empty on `waiting`. `is-now` on the stage the
  caption names. Right of the bar, `N / M stages`.
- **Caption.** Active stage name, then its status label. Full width. The count deliberately rides
  the bar row instead, because at 250px a caption carrying all three truncates the name.
- **Repair row.** Label, `maxRepairRounds + 1` pips, `R{round} / {maxRepairRounds}`. Rounds before
  the current one are spent; the current one is toned and ringed. When `round > maxRepairRounds`,
  the current pip is danger-toned **and** the row prints `no repairs left`.

Then the existing error sentence, unchanged in content, at full tile width.

### 4. Make the placeholder variant-aware

`WorkflowLadderPeekPlaceholder` gains the same repair row and drops the round from its header when
the progress-bar variant is on. This is what the settings preview shows, and what makes the new
checkbox visibly do something there.

### 5. Wire the variant through

- `src/web/lib/board-card.ts`: one `DISPLAY_ITEMS` entry, `id: "workflowProgressBar"`,
  `group: "card"`. Write the `description` as **what unchecking loses**, matching the file's stated
  convention at `:44` - and note this is the one entry where unchecking substitutes rather than
  removes, so the description has to say so.
- `src/shared/protocol.ts`: **no change.** Absence from `UI_CONFIG_DEFAULTS.hiddenDisplayItems`
  (`:2869`) is what ships it on.
- `src/web/components/layouts/SessionTile.tsx`: read `shown("workflowProgressBar")` and pass it to
  `WorkflowLadderPanel`. The gate must live here - `test/board-card-items.test.ts:91` asserts the
  tile holds a `shown("<id>")` for every registry id, and `:114` forbids a second read of
  `hiddenDisplayItems` in the tile.
- `src/web/workflows/WorkflowLadder.tsx`: accept the variant on `WorkflowLadderPanel` and pass it to
  the peek and the placeholder. `SessionWorkflowsPane` and the console keep today's rung - they are
  not board cards and have the room.
- `src/web/lib/settings-search.ts:180`: add keywords for the new item so the palette finds it.

### 6. Fix the 250px collision

`.wf-tile-peek-title strong` (`src/web/styles.css:26644`) is `flex: none` and
`.wf-tile-peek-state` (`:26657`) is `flex: none; margin-left: auto`, so neither yields and the row's
8px gap collapses at a 250px column. Let the title shrink and ellipsize; keep the gap; keep the
status label unshrinkable, since it is short and is the thing being read.

### 7. Correct the default-state test's rationale

`test/board-card-items.test.ts:172` passes mechanically but its comment - "Every other id names
something a card already drew, so its absence from this list is what makes an upgrade move nothing
on screen" - becomes false. Record that `workflowProgressBar` is the deliberate exception and why.

## Tests and verification

New coverage, in `test/` unless stated:

- The exported stage projection: segment count equals the pipeline's stage count; a carried pass and
  a degraded skip both render as resolved-but-hatched rather than pending; the `is-now` stage is the
  one `workflowLadderPeekView` names.
- The repair-pip model: pip count is `maxRepairRounds + 1`; the current pip is at `round - 1`;
  `round === maxRepairRounds + 1` is the only state that prints `no repairs left`; a run at that
  round with `status: "completed"` is **not** described as failed.
- `PipelinePhaseMeter` markup is unchanged by the extraction.
- `board-card-items.test.ts`: passes with the new entry, including the preview-populates-every-item
  assertion. That one is the real gate on step 4.
- The collision, at width. `renderToStaticMarkup` cannot see it - it is a layout fact - so this
  needs the Electron geometry layer (`npm run test:electron`) or a Playwright assertion at a 250px
  column. Assert the two elements do not overlap.
- **Playwright spec in `e2e/`** (required for any Board change): the meter renders for a
  stage-shaped run; the segment count matches; the repair row marks the current round; unchecking
  the setting in the panel returns the rung tile; the choice survives a reload. Select by role,
  label, or placeholder - **never** add a `data-testid`. Keep every agent binary faked per
  `e2e/fixtures/fake-agents.ts`; this spec must spend no model tokens.

Commands:

```sh
npm run typecheck
npm run lint
node --test --import ./test/setup-state.mjs --import tsx test/board-card-items.test.ts
npm test
npm run build
npm run smoke
npm run test:e2e
```

`npm run build` and `npm run smoke` because a runtime surface changed; `npm run test:e2e` because a
UI surface did, and it needs the build first plus a one-time `npx playwright install chromium`.

Visual check at **both** 250px and 300px board column widths. The collision is invisible at 300px,
and the source plan's height table was measured at both - so a regression at one width would pass a
check done only at the other.

## Merge and exit criteria

- Every command above passes, `npm run test:e2e` included.
- The new tile is default-on; unchecking the box returns today's rung tile; the choice survives a
  reload.
- The ai-conductor pipeline meter is visually and structurally unchanged.
- The settings preview visibly changes when the box is toggled.
- No fabricated `WorkflowRunDetail` was added to the preview fixture.
- The rung tile no longer collides name into status at 250px, with a test that fails if it returns.
- One reviewable pull request, opened per `mission-pull-request`, with before/after screenshots at
  both column widths.

## Downstream handoff

Nothing depends on this phase - it is the only one. For whatever comes next:

- `workflowLadderStages` and `StagePeek` are now public API of `WorkflowLadderPeek.tsx`. Anything
  needing per-stage status should consume them rather than re-deriving from `run-model.ts`.
- The shared segment meter is the one segmented bar. A third meter uses it; it does not fork it.
- `workflowProgressBar` is the one registry entry whose unchecked state substitutes a different view
  rather than removing one. If a second such entry ever appears, that is the moment to revisit
  whether `DISPLAY_ITEMS` should carry a variant kind instead of the decision taken here.
- Option C (gate-level ticks) is where member-level detail comes back if the stage-level bar proves
  too coarse. It would need the fixture question in finding 1 answered differently.

## Cross-phase audit record

- **2026-09-03, single-phase audit.** No earlier phase to reconcile against. Audited the phase
  against the source plan and its four submitted decisions: Option B is the design implemented in
  steps 3 and 4; the registry mechanism is step 5; the collision fix is step 6; the phased-plan
  follow-up is this document set. Every source-plan requirement is owned here, and no requirement is
  owned twice.
- **2026-09-03, plan correction folded in.** The source plan's original "repair budget overrun" red
  overflow pip was disproved by `src/shared/workflow.ts:136` and `workflowRunGaveUp`, and by the
  live population (zero runs above `maxRepairRounds + 1`). `plan.md` and the comparison renders were
  corrected before this phase was written, so step 3 describes the corrected model - pip count
  `maxRepairRounds + 1`, no overflow case, `no repairs left` in words as well as tone. Recorded
  because the first draft of the design was wrong in a way that would have shipped a false alarm on
  a healthy run.
